import { execFileSync } from 'node:child_process';
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

import { afterEach, describe, expect, it } from 'vitest';

/**
 * End-to-end verification of the JoyCode usage adapter against the REAL bundled
 * CLI (`dist/agent-usage.mjs`). No production code is mocked: install, configure
 * and report are all driven through `execFileSync` against a disposable fake
 * HOME + AGENT_USAGE_HOME so nothing ever touches the real `~/.joycode` or the
 * real `~/.agent-usage`.
 *
 * Selection is OPT-IN: install registers the accounting server + usage skill +
 * prompt entry but wraps no servers and injects no skill blocks until `configure`
 * selects them.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BUNDLE = join(REPO_ROOT, 'dist', 'agent-usage.mjs');
const FAKE_SERVER = join(REPO_ROOT, 'tests', 'fixtures', 'fake-mcp-server.mjs');

/** Marker inserted at the top of an injected-mcp skill. */
const MANAGED_BLOCK_BEGIN = '<!-- agent-usage:begin v1 -->';

interface JoyCodeMcpEntry {
  command?: string;
  args?: string[];
  url?: string;
  [key: string]: unknown;
}

interface JoyCodeMcpConfig {
  mcpServers?: Record<string, JoyCodeMcpEntry>;
  [key: string]: unknown;
}

interface PromptEntry {
  label?: unknown;
  [key: string]: unknown;
}

/** Run the bundled CLI in a fresh child process; throws on non-zero exit. */
function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync(process.execPath, [BUNDLE, ...args], {
    env,
    input,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('joycode adapter end-to-end (real bundle)', () => {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `Expected built bundle at ${BUNDLE}. Run \`npm run build\` before this test.`,
    );
  }

  // HOME-overlap safety guard: never pollute the caller's real HOME/.joycode or
  // real ~/.agent-usage.
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
    const home = mkdtempSync(join(tmpdir(), 'joycode-e2e-'));
    if (home === realHome || realHome.startsWith(home)) {
      throw new Error(`Temp HOME overlaps the real HOME: ${home}`);
    }
    tempHomes.push(home);

    // Seed a fake JoyCode home: a user MCP config with one stdio server and one
    // remote (url) server, plus a user Skill with frontmatter.
    const joycodeDir = join(home, '.joycode');
    mkdirSync(joycodeDir, { recursive: true });

    const mcpConfig: JoyCodeMcpConfig = {
      mcpServers: {
        fake: { command: process.execPath, args: [FAKE_SERVER] },
        remote: { url: 'https://example.test/mcp' },
      },
    };
    writeFileSync(
      join(joycodeDir, 'joycode-mcp.json'),
      `${JSON.stringify(mcpConfig, null, 2)}\n`,
    );

    const deployDir = join(joycodeDir, 'skills', 'deploy');
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(
      join(deployDir, 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy the service.\n---\n\nDeploy the thing.\n',
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      AGENT_USAGE_HOME: join(home, '.agent-usage'),
    };
    return { home, env };
  }

  function readMcpConfig(home: string): JoyCodeMcpConfig {
    return readJson<JoyCodeMcpConfig>(join(home, '.joycode', 'joycode-mcp.json'));
  }

  function readSkill(home: string, name: string): string {
    return readFileSync(join(home, '.joycode', 'skills', name, 'SKILL.md'), 'utf8');
  }

  it('install is opt-in: registers accounting infra but wraps/injects nothing', () => {
    const { home, env } = freshEnv();

    const out = runCli(['install', 'joycode'], env);
    expect(out).toContain('success');
    expect(out).toContain('installed joycode adapter');

    const config = readMcpConfig(home);
    const servers = config.mcpServers ?? {};

    // The accounting server IS registered, pointing at the runtime `mcp`
    // subcommand for this agent.
    expect(servers['usage-stats']).toBeDefined();
    expect(servers['usage-stats']?.command).toBe(process.execPath);
    expect(servers['usage-stats']?.args).toEqual(
      expect.arrayContaining(['mcp', '--agent', 'joycode']),
    );

    // The fake stdio server is NOT yet wrapped (opt-in): its command is still
    // the bare node binary and its args are NOT the proxy invocation.
    const fake = servers.fake;
    expect(fake?.command).toBe(process.execPath);
    expect(fake?.args).toEqual([FAKE_SERVER]);
    expect(fake?.args).not.toContain('proxy');

    // The remote (url) server is untouched.
    expect(servers.remote).toEqual({ url: 'https://example.test/mcp' });

    // The usage-stats skill exists.
    expect(existsSync(join(home, '.joycode', 'skills', 'usage-stats', 'SKILL.md'))).toBe(true);

    // The usage-stats prompt entry exists.
    const prompts = readJson<PromptEntry[]>(join(home, '.joycode', 'prompt.json'));
    expect(prompts.some((entry) => entry.label === 'usage-stats')).toBe(true);

    // The user Skill has NO managed accounting block yet (nothing selected).
    expect(readSkill(home, 'deploy')).not.toContain(MANAGED_BLOCK_BEGIN);
  });

  it('install is idempotent (second install adds no duplicates)', () => {
    const { home, env } = freshEnv();

    runCli(['install', 'joycode'], env);
    const before = readMcpConfig(home);
    const beforePrompts = readJson<PromptEntry[]>(join(home, '.joycode', 'prompt.json'));
    const beforeSkill = readSkill(home, 'usage-stats');

    runCli(['install', 'joycode'], env);

    const after = readMcpConfig(home);
    const afterServers = Object.keys(after.mcpServers ?? {});
    const beforeServers = Object.keys(before.mcpServers ?? {});

    // Exactly one accounting server, no new servers introduced.
    expect(afterServers.filter((name) => name === 'usage-stats')).toHaveLength(1);
    expect(afterServers.sort()).toEqual([...beforeServers].sort());

    // The fake server is still not wrapped.
    expect(after.mcpServers?.fake?.args).not.toContain('proxy');

    // Single prompt entry, identical skill content.
    const afterPrompts = readJson<PromptEntry[]>(join(home, '.joycode', 'prompt.json'));
    expect(
      afterPrompts.filter((entry) => entry.label === 'usage-stats'),
    ).toHaveLength(1);
    expect(afterPrompts).toHaveLength(beforePrompts.length);
    expect(readSkill(home, 'usage-stats')).toBe(beforeSkill);

    // deploy still unblocked.
    expect(readSkill(home, 'deploy')).not.toContain(MANAGED_BLOCK_BEGIN);
  });

  it('configure wraps selected stdio servers and injects selected skills', () => {
    const { home, env } = freshEnv();

    runCli(['install', 'joycode'], env);

    const out = runCli(
      ['configure', 'joycode', '--inject-skill', 'deploy', '--mcp', 'fake'],
      env,
    );
    expect(out).toContain('configured joycode selection policy');

    const config = readMcpConfig(home);
    const servers = config.mcpServers ?? {};

    // fake is now wrapped through the proxy.
    const fake = servers.fake;
    expect(fake?.command).toBe(process.execPath);
    expect(fake?.args).toEqual(
      expect.arrayContaining(['proxy', '--agent', 'joycode', '--server', 'fake']),
    );
    // The original command/args are preserved after the `--` separator.
    expect(fake?.args).toContain('--');
    expect(fake?.args).toContain(FAKE_SERVER);

    // remote is still untouched (url, not wrappable).
    expect(servers.remote).toEqual({ url: 'https://example.test/mcp' });

    // The accounting server remains registered exactly once.
    expect(servers['usage-stats']).toBeDefined();

    // deploy now carries the managed accounting block.
    expect(readSkill(home, 'deploy')).toContain(MANAGED_BLOCK_BEGIN);
    expect(readSkill(home, 'deploy')).toContain('record_skill');
  });

  it('report 7d runs cleanly after install', () => {
    const { home, env } = freshEnv();

    runCli(['install', 'joycode'], env);

    // report must run without error even when no events have been recorded.
    const report = runCli(['report', '7d'], env);
    expect(report).toContain('Usage statistics');
    expect(report).toContain('7d');
  });
});
