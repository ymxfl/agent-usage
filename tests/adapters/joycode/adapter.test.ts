import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createJoyCodeAdapter } from '../../../src/adapters/joycode/adapter.js';
import { joyCodePaths } from '../../../src/adapters/joycode/paths.js';
import { USAGE_PROMPT_LABEL } from '../../../src/adapters/joycode/prompt-config.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const RUNTIME_BUNDLE = Buffer.from('#!/usr/bin/env node\nruntime\n');

interface Fixture {
  home: string;
  cwd: string;
  usageStateDir: string;
  selectionConfigPath: string;
  paths: ReturnType<typeof joyCodePaths>;
  adapter: ReturnType<typeof createJoyCodeAdapter>;
}

function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'agent-usage-joycode-'));
  tempDirectories.push(home);
  const cwd = mkdtempSync(join(tmpdir(), 'agent-usage-joycode-cwd-'));
  tempDirectories.push(cwd);
  const usageStateDir = join(home, 'state');
  const selectionConfigPath = join(home, 'config.json');
  const paths = joyCodePaths(home, cwd);
  return {
    home,
    cwd,
    usageStateDir,
    selectionConfigPath,
    paths,
    adapter: createJoyCodeAdapter({
      home,
      cwd,
      usageStateDir,
      selectionConfigPath,
      runtimeBundle: RUNTIME_BUNDLE,
    }),
  };
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

describe('createJoyCodeAdapter', () => {
  it('exposes the joycode id and capability set', () => {
    const { adapter } = makeFixture();
    expect(adapter.id).toBe('joycode');
    expect(adapter.capabilities).toEqual({
      nativeSkillEvents: false,
      skillInjection: true,
      nativeMcpEvents: false,
      stdioMcpProxy: true,
      skillWatching: true,
    });
  });
});

describe('install', () => {
  it('writes runtime, wraps a stdio server, leaves remote untouched, registers accounting + prompt + skill, all success', async () => {
    const { adapter, home, paths } = makeFixture();
    // Pre-existing user MCP config with a stdio server + a remote + a sibling.
    await mkdir(join(home, '.joycode'), { recursive: true });
    await writeFile(
      paths.userMcp,
      JSON.stringify({
        unrelated: true,
        mcpServers: {
          github: { command: 'npx', args: ['gh-mcp'] },
          remote: { url: 'https://example.test/mcp' },
        },
      }),
    );
    // Pre-existing prompt entry that must be preserved.
    await writeFile(paths.userPrompts, JSON.stringify([{ label: 'other', name: 'other' }]));

    const results = await adapter.install('user');

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.status !== 'failed')).toBe(true);

    // Runtime written and executable.
    const runtimePath = join(home, '.joycode', 'agent-usage-runtime.mjs');
    expect(Buffer.from(await readFile(runtimePath))).toEqual(RUNTIME_BUNDLE);

    // MCP config: usage-stats registered, github wrapped (args contain 'proxy'),
    // remote untouched, sibling preserved. Install is opt-in with no policy, so
    // github must NOT be wrapped.
    const config = (await readJsonIfExists(paths.userMcp)) as {
      unrelated: boolean;
      mcpServers: Record<string, { command?: string; args?: string[]; url?: string }>;
    };
    expect(config.unrelated).toBe(true);
    expect(config.mcpServers['usage-stats']).toBeDefined();
    expect(config.mcpServers['usage-stats']?.args).toEqual([
      join(home, '.joycode', 'agent-usage-runtime.mjs'),
      'mcp',
      '--agent',
      'joycode',
    ]);
    // No policy yet => opt-in: github is NOT wrapped.
    const github = config.mcpServers.github;
    expect(github?.command).toBe('npx');
    expect(github?.args).toEqual(['gh-mcp']);
    expect(config.mcpServers.remote).toEqual({ url: 'https://example.test/mcp' });

    // Prompt file: usage-stats entry added, sibling preserved.
    const prompts = (await readJsonIfExists(paths.userPrompts)) as Array<{ label: string }>;
    const labels = prompts.map((entry) => entry.label);
    expect(labels).toContain(USAGE_PROMPT_LABEL);
    expect(labels).toContain('other');

    // usage-stats Skill written.
    const skillPath = join(paths.userSkills, 'usage-stats', 'SKILL.md');
    expect(await readFile(skillPath, 'utf8')).toContain('name: usage-stats');
  });

  it('is idempotent: installing twice is stable (single usage-stats, no double-registration)', async () => {
    const { adapter, paths } = makeFixture();

    await adapter.install('user');
    const firstMcp = (await readJsonIfExists(paths.userMcp)) as {
      mcpServers: Record<string, unknown>;
    };
    await adapter.install('user');
    const secondMcp = (await readJsonIfExists(paths.userMcp)) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(secondMcp.mcpServers)).toEqual(
      Object.keys(firstMcp.mcpServers),
    );
    expect(secondMcp.mcpServers['usage-stats']).toEqual(
      firstMcp.mcpServers['usage-stats'],
    );
    expect(resultsNonFailed(await adapter.install('user'))).toBe(true);
  });

  it('reports best-effort / stdio-only coverage via health after install', async () => {
    const { adapter } = makeFixture();
    await adapter.install('user');

    const coverage = await adapter.health();
    expect(coverage.agent).toBe('joycode');
    expect(coverage.skills).toBe('none injected');
    expect(coverage.mcp).toContain('stdio-only');
  });

  it('discover reflects install state', async () => {
    const { adapter } = makeFixture();
    expect(await adapter.discover()).toEqual([]);
    await adapter.install('user');
    const discovered = await adapter.discover();
    expect(discovered.length).toBeGreaterThan(0);
  });
});

describe('uninstall', () => {
  it('restores the original MCP config, removes prompt entry + skill, and preserves unrelated config', async () => {
    const { adapter, home, paths } = makeFixture();
    await mkdir(join(home, '.joycode'), { recursive: true });
    const originalMcp = {
      unrelated: true,
      mcpServers: {
        github: { command: 'npx', args: ['gh-mcp'] },
        remote: { url: 'https://example.test/mcp' },
      },
    };
    await writeFile(paths.userMcp, JSON.stringify(originalMcp));
    await writeFile(
      paths.userPrompts,
      JSON.stringify([{ label: 'other', name: 'other' }]),
    );

    await adapter.install('user');
    // Configure so github is wrapped (exercises the restore path).
    await adapter.configure({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: ['github'],
    });

    const results = await adapter.uninstall('user');
    expect(results.every((result) => result.status !== 'failed')).toBe(true);

    // MCP restored: github command restored, usage-stats gone, sibling kept.
    const restored = (await readJsonIfExists(paths.userMcp)) as {
      unrelated: boolean;
      mcpServers: Record<string, { command?: string; args?: string[]; url?: string }>;
    };
    expect(restored.unrelated).toBe(true);
    expect(restored.mcpServers.github).toEqual({ command: 'npx', args: ['gh-mcp'] });
    expect(restored.mcpServers.remote).toEqual({ url: 'https://example.test/mcp' });
    expect(restored.mcpServers['usage-stats']).toBeUndefined();

    // Prompt entry removed, sibling preserved.
    const prompts = (await readJsonIfExists(paths.userPrompts)) as Array<{ label: string }>;
    expect(prompts.map((entry) => entry.label)).toEqual(['other']);

    // usage-stats Skill removed.
    expect(existsSync(join(paths.userSkills, 'usage-stats', 'SKILL.md'))).toBe(false);
  });

  it('reports degraded (not overwritten) for a user-edited wrapped server on uninstall', async () => {
    const { adapter, home, paths } = makeFixture();
    await mkdir(join(home, '.joycode'), { recursive: true });
    await writeFile(
      paths.userMcp,
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['gh'] } } }),
    );

    await adapter.install('user');
    await adapter.configure({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: ['github'],
    });

    // Simulate a user edit to the wrapped entry.
    const wrapped = (await readJsonIfExists(paths.userMcp)) as {
      mcpServers: { github: { args: string[] } };
    };
    wrapped.mcpServers.github.args.push('user-edit');
    await writeFile(paths.userMcp, JSON.stringify(wrapped));

    const results = await adapter.uninstall('user');
    expect(results.some((result) => result.status === 'degraded')).toBe(true);

    // The user-edited entry survives.
    const after = (await readJsonIfExists(paths.userMcp)) as {
      mcpServers: { github: { args: string[] } };
    };
    expect(after.mcpServers.github.args).toContain('user-edit');
  });
});

describe('cross-module MCP round-trip parity (adapter wrap -> restoreJoyCodeMcpConfig)', () => {
  it('a config wrapped by the adapter restores to the original via restoreJoyCodeMcpConfig', async () => {
    const { restoreJoyCodeMcpConfig } = await import(
      '../../../src/adapters/joycode/mcp-config.js'
    );
    const { adapter, home, paths, usageStateDir } = makeFixture();
    await mkdir(join(home, '.joycode'), { recursive: true });

    const original = {
      unrelated: true,
      mcpServers: {
        github: { command: 'npx', args: ['gh-mcp'], env: { ROOT: '/x' } },
        remote: { url: 'https://example.test/mcp' },
      },
    };
    await writeFile(paths.userMcp, JSON.stringify(original));

    // The adapter wraps github (selection-aware) and persists the manifest whose
    // hashing is its OWN. restoreJoyCodeMcpConfig (used by uninstall) hashes via
    // mcp-config.ts's separate serializer. This pins their parity.
    await adapter.install('user');
    const configureResults = await adapter.configure({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: ['github'],
    });
    expect(resultsNonFailed(configureResults)).toBe(true);

    const wrapped = JSON.parse(await readFile(paths.userMcp, 'utf8'));
    const manifestPath = join(usageStateDir, 'joycode-mcp-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

    const restored = restoreJoyCodeMcpConfig(
      wrapped,
      manifest,
    );
    expect(restored).toEqual(original);
  });

  it('restoreJoyCodeMcpConfig throws for an entry the adapter wrapped but a user later edited', async () => {
    const { restoreJoyCodeMcpConfig } = await import(
      '../../../src/adapters/joycode/mcp-config.js'
    );
    const { adapter, home, paths, usageStateDir } = makeFixture();
    await mkdir(join(home, '.joycode'), { recursive: true });
    await writeFile(
      paths.userMcp,
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['gh'] } } }),
    );

    await adapter.install('user');
    await adapter.configure({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: ['github'],
    });

    const wrapped = JSON.parse(await readFile(paths.userMcp, 'utf8')) as {
      mcpServers: { github: { args: string[] } };
    };
    wrapped.mcpServers.github.args.push('user-edit');
    const manifestPath = join(usageStateDir, 'joycode-mcp-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

    expect(() => restoreJoyCodeMcpConfig(wrapped, manifest)).toThrow(/github/);
  });
});

function resultsNonFailed(results: { status: string }[]): boolean {
  return results.every((result) => result.status !== 'failed');
}
