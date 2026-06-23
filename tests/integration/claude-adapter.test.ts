import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * End-to-end verification of the Claude Code usage adapter against the REAL
 * bundled CLI (`dist/agent-usage.mjs`). No production code is mocked: install,
 * configure, hook and report are all driven through `execFileSync` against a
 * disposable fake HOME so nothing ever touches the real `~/.claude` or the real
 * `~/.agent-usage`.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BUNDLE = join(REPO_ROOT, 'dist', 'agent-usage.mjs');

const MCP_TOOL_PREFIX = 'mcp__';

/** Absolute path to a fixture under tests/fixtures/claude-hooks. */
function fixture(name: string): string {
  return join(REPO_ROOT, 'tests', 'fixtures', 'claude-hooks', name);
}

/**
 * Run the bundled CLI in a fresh child process. Throws on non-zero exit so a
 * failing step fails the test informatively (the thrown error carries stderr).
 */
function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync(process.execPath, [BUNDLE, ...args], {
    env,
    input,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    // Give the bundled process a generous but bounded lifetime.
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

interface FixtureFacts {
  /** Skill name extracted from the PostToolUse Skill fixture. */
  skill: string;
  /** MCP server parsed from the mcp__<server>__<tool> tool name. */
  mcpServer: string;
}

/** Read the two fixtures and extract the exact skill name + MCP server. */
function readFixtureFacts(): FixtureFacts {
  const skillPayload = JSON.parse(
    readFileSync(fixture('model-skill-success.json'), 'utf8'),
  ) as { tool_input?: { skill?: string; name?: string } };
  const skill =
    skillPayload.tool_input?.skill?.trim() ??
    skillPayload.tool_input?.name?.trim();
  if (skill === undefined || skill.length === 0) {
    throw new Error('model-skill-success.json fixture has no skill name');
  }

  const mcpPayload = JSON.parse(
    readFileSync(fixture('mcp-success.json'), 'utf8'),
  ) as { tool_name: string };
  const toolName = mcpPayload.tool_name;
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) {
    throw new Error(`mcp-success.json fixture tool_name is not an MCP tool: ${toolName}`);
  }
  const remainder = toolName.slice(MCP_TOOL_PREFIX.length);
  const separator = remainder.indexOf('__');
  if (separator <= 0) {
    throw new Error(`mcp-success.json fixture tool_name has no server: ${toolName}`);
  }
  const mcpServer = remainder.slice(0, separator);

  return { skill, mcpServer };
}

/** A glob prefix that matches the discovered MCP server (e.g. "github*"). */
function mcpGlob(server: string): string {
  // The first underscore-delimited segment is a stable server family prefix
  // (e.g. "github" for "github_enterprise-v2"). Use it as the glob so the test
  // exercises pattern matching rather than an exact string.
  const prefix = server.split('_')[0] ?? '';
  return prefix.length === 0 ? server : `${prefix}*`;
}

describe('claude adapter end-to-end (real bundle)', () => {
  // Sanity: the bundle must exist; the suite assumes `npm run build` ran.
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `Expected built bundle at ${BUNDLE}. Run \`npm run build\` before this test.`,
    );
  }

  // Sanity guard: never pollute the caller's real HOME/.agent-usage.
  const realHome = homedir();

  const tempHomes: string[] = [];

  afterEach(() => {
    while (tempHomes.length > 0) {
      const home = tempHomes.pop()!;
      // Defensive: a temp HOME must never be inside or equal to the real HOME,
      // otherwise cleanup could destroy the caller's real config.
      if (home === realHome || realHome.startsWith(home)) {
        throw new Error(`Refusing to clean a HOME that overlaps the real HOME: ${home}`);
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  function freshEnv(): { home: string; env: NodeJS.ProcessEnv } {
    const home = mkdtempSync(join(tmpdir(), 'claude-e2e-'));
    if (home === realHome || realHome.startsWith(home)) {
      throw new Error(`Temp HOME overlaps the real HOME: ${home}`);
    }
    tempHomes.push(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      // Pin the usage database + selection config under the temp HOME. The
      // default Claude adapter writes its selection policy to
      // <home>/.agent-usage/config.json and the CLI reads the same path via
      // usagePaths(), so the two must agree.
      AGENT_USAGE_HOME: join(home, '.agent-usage'),
    };
    return { home, env };
  }

  it('records selected Skill and MCP events through install → configure → hook → report', () => {
    const { skill, mcpServer } = readFixtureFacts();
    const mcpPattern = mcpGlob(mcpServer);
    const { home, env } = freshEnv();

    // 1. install (real bundle, temp HOME).
    const installOut = runCli(['install', 'claude-code'], env);
    expect(installOut).toContain('success');
    expect(installOut).toContain(home);

    // 2. configure the selection policy (opt-in): native-hook the Skill and
    //    glob-match the MCP server. install alone records nothing.
    const configureOut = runCli(
      ['configure', 'claude-code', '--native-skill', skill, '--mcp', mcpPattern],
      env,
    );
    expect(configureOut).toContain('configured claude-code selection policy');

    // 3. feed the Skill invocation through the hidden hook command.
    const skillPayload = readFileSync(fixture('model-skill-success.json'), 'utf8');
    runCli(['hook', 'claude'], env, skillPayload);

    // 4. feed the MCP call through the hidden hook command.
    const mcpPayload = readFileSync(fixture('mcp-success.json'), 'utf8');
    runCli(['hook', 'claude'], env, mcpPayload);

    // 5. report reflects BOTH recorded events.
    const report = runCli(['report', 'today'], env);

    // Core assertions: the Skill name and the MCP server both appear.
    expect(report).toContain(skill);
    expect(report).toContain(mcpServer);

    // Coverage labels: native-hook evidence is surfaced in the Totals rows.
    expect(report).toContain('native_hook');
    expect(report).toContain('skill_invocation');
    expect(report).toContain('mcp_call');

    // The MCP row names the qualified tool and shows exactly one attempt.
    expect(report).toContain('1 attempt');

    // No over-recording: both the success and failure MCP fixtures would share
    // the same tool_use_id, but only the selected success fixture was fed, so
    // there must be exactly one attempt and no failures.
    expect(report).toContain('failure 0');
  });

  it('does not record events when no selection policy is configured (opt-in)', () => {
    const { skill, mcpServer } = readFixtureFacts();
    const { env } = freshEnv();

    // install but DO NOT configure — collection is opt-in.
    runCli(['install', 'claude-code'], env);

    // Feed the same hooks; with an empty policy they must be ignored.
    runCli(
      ['hook', 'claude'],
      env,
      readFileSync(fixture('model-skill-success.json'), 'utf8'),
    );
    runCli(
      ['hook', 'claude'],
      env,
      readFileSync(fixture('mcp-success.json'), 'utf8'),
    );

    const report = runCli(['report', 'today'], env);

    // Neither the Skill nor the MCP server should appear.
    expect(report).not.toContain(skill);
    expect(report).not.toContain(mcpServer);
    // Totals should be empty.
    expect(report).toContain('- None');
  });
});
