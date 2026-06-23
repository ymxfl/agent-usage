import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * End-to-end verification that the JoyCode proxy actually records telemetry for
 * a proxied stdio MCP call, WITHOUT storing the tool arguments or results.
 *
 * Drives the REAL bundled CLI (`dist/agent-usage.mjs`) through install +
 * configure against a disposable HOME + AGENT_USAGE_HOME, then spawns the
 * WRAPPED proxy command (read back from the JoyCode mcp config) directly,
 * feeds it a JSON-RPC `tools/call` carrying a secret argument, and asserts on
 * the resulting rows in the real usage database.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BUNDLE = join(REPO_ROOT, 'dist', 'agent-usage.mjs');
const FAKE_SERVER = join(REPO_ROOT, 'tests', 'fixtures', 'fake-mcp-server.mjs');

const SECRET = 'SECRET-TOKEN';

interface JoyCodeMcpEntry {
  command?: string;
  args?: string[];
  url?: string;
  [key: string]: unknown;
}

interface JoyCodeMcpConfig {
  mcpServers?: Record<string, JoyCodeMcpEntry>;
}

interface UsageRow {
  schema_version: number;
  occurred_at: string;
  agent: string;
  session_id: string | null;
  project: string | null;
  kind: string;
  name: string;
  skill_id: string | null;
  mcp_server: string | null;
  outcome: string;
  duration_ms: number | null;
  evidence: string;
  precision: string;
  dedupe_key: string;
}

/** Run the bundled CLI in a fresh child process; throws on non-zero exit. */
function runCli(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [BUNDLE, ...args], {
    env,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readRows(databasePath: string): UsageRow[] {
  // Open read-write: node:sqlite's readOnly mode cannot recover a WAL-mode
  // database (it needs to create/inspect the -shm/-wal sidecars), which throws
  // "unable to open database file". The database lives under a disposable temp
  // HOME, so a read-write handle used only for SELECTs is safe.
  const database = new DatabaseSync(databasePath);
  try {
    const statement = database.prepare(
      'SELECT schema_version, occurred_at, agent, session_id, project, kind, name, skill_id, mcp_server, outcome, duration_ms, evidence, precision, dedupe_key FROM usage_events ORDER BY id ASC',
    );
    return statement.all() as unknown as UsageRow[];
  } finally {
    database.close();
  }
}

/**
 * Spawn the wrapped proxy command, send one (or more) JSON-RPC `tools/call`
 * requests over stdin, drain stdout until every expected response arrives, then
 * close stdin and await exit. Returns the aggregated stdout text.
 */
function driveProxy(
  command: string,
  args: string[],
  requests: object[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
      // The proxy child resolves its usage DB + selection policy from the env,
      // so it MUST inherit the disposable HOME + AGENT_USAGE_HOME — otherwise it
      // would read/write the caller's real ~/.agent-usage.
      env,
    });

    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`proxy timed out after ${timeoutMs}ms; stdout so far:\n${stdout}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code });
    });

    // Send each request as a newline-delimited JSON-RPC frame, then end stdin.
    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    child.stdin.end();
  });
}

describe('joycode proxy end-to-end (real bundle + real DB)', () => {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `Expected built bundle at ${BUNDLE}. Run \`npm run build\` before this test.`,
    );
  }

  const realHome = homedir();
  const tempHomes: string[] = [];

  afterEach(() => {
    while (tempHomes.length > 0) {
      const home = tempHomes.pop()!;
      if (home === realHome || realHome.startsWith(home)) {
        throw new Error(`Refusing to clean a HOME that overlaps the real HOME: ${home}`);
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  function freshEnv(): { home: string; env: NodeJS.ProcessEnv } {
    const home = mkdtempSync(join(tmpdir(), 'joycode-proxy-e2e-'));
    if (home === realHome || realHome.startsWith(home)) {
      throw new Error(`Temp HOME overlaps the real HOME: ${home}`);
    }
    tempHomes.push(home);

    const joycodeDir = join(home, '.joycode');
    mkdirSync(joycodeDir, { recursive: true });
    const mcpConfig: JoyCodeMcpConfig = {
      mcpServers: {
        fake: { command: process.execPath, args: [FAKE_SERVER] },
      },
    };
    writeFileSync(
      join(joycodeDir, 'joycode-mcp.json'),
      `${JSON.stringify(mcpConfig, null, 2)}\n`,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      AGENT_USAGE_HOME: join(home, '.agent-usage'),
    };
    return { home, env };
  }

  it('records one successful proxied tools/call and stores no secrets', async () => {
    const { home, env } = freshEnv();

    // install registers the accounting infra; configure (opt-in) wraps `fake`
    // through the proxy AND persists a non-empty mcp selection policy (the
    // proxy only records when policy.mcp is non-empty for the agent).
    runCli(['install', 'joycode'], env);
    const configureOut = runCli(['configure', 'joycode', '--mcp', 'fake'], env);
    expect(configureOut).toContain('configured joycode selection policy');

    // Read the WRAPPED entry back from the mcp config.
    const config = readJson<JoyCodeMcpConfig>(join(home, '.joycode', 'joycode-mcp.json'));
    const fake = config.mcpServers?.fake;
    expect(fake?.command).toBe(process.execPath);
    expect(fake?.args).toContain('proxy');
    expect(fake?.command).toBeDefined();
    expect(fake?.args).toBeDefined();

    // Drive one proxied tools/call carrying a secret argument. The fake server
    // resolves the `search` tool to a plain `ok` result (outcome: success).
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search', arguments: { token: SECRET } },
    };
    const { stdout } = await driveProxy(fake!.command!, fake!.args!, [request], env);

    // The proxy relayed the response verbatim.
    expect(stdout).toContain('"id":1');
    expect(stdout).toContain('"result"');

    const databasePath = join(home, '.agent-usage', 'usage.db');
    const rows = readRows(databasePath);

    // Exactly ONE mcp_call event, recorded by the proxy.
    expect(rows).toHaveLength(1);
    const event = rows[0]!;
    expect(event.kind).toBe('mcp_call');
    expect(event.evidence).toBe('mcp_proxy');
    expect(event.outcome).toBe('success');
    expect(event.name).toBe('search');
    expect(event.mcp_server).toBe('fake');
    expect(event.agent).toBe('joycode');

    // The secret argument is NOWHERE in the database: arguments and results are
    // never persisted (only id/method/tool-name metadata is retained).
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    // The response payload (the literal "ok" the server returned) must also be
    // absent from the recorded rows.
    expect(JSON.stringify(rows)).not.toContain('content');
  });

  it('records a failing tools/call with outcome: failure', async () => {
    const { home, env } = freshEnv();

    runCli(['install', 'joycode'], env);
    runCli(['configure', 'joycode', '--mcp', 'fake'], env);

    const config = readJson<JoyCodeMcpConfig>(join(home, '.joycode', 'joycode-mcp.json'));
    const fake = config.mcpServers?.fake;

    // The fake server resolves the `error` tool name to a JSON-RPC error
    // response, which the proxy records as outcome: failure.
    const request = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'error', arguments: { token: SECRET } },
    };
    const { stdout } = await driveProxy(fake!.command!, fake!.args!, [request], env);
    expect(stdout).toContain('"error"');

    const rows = readRows(join(home, '.agent-usage', 'usage.db'));
    expect(rows).toHaveLength(1);
    const event = rows[0]!;
    expect(event.kind).toBe('mcp_call');
    expect(event.evidence).toBe('mcp_proxy');
    expect(event.outcome).toBe('failure');
    expect(event.name).toBe('error');
    expect(event.mcp_server).toBe('fake');

    // No secret leaked even on failure.
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});
