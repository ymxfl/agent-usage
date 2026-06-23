import { createHash } from 'node:crypto';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeAdapter } from '../../../src/adapters/claude/adapter.js';
import { claudePluginFiles } from '../../../src/adapters/claude/plugin-files.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  home: string;
  selectionConfigPath: string;
  runtimeBundle: Uint8Array;
  adapter: ReturnType<typeof createClaudeAdapter>;
}

const RUNTIME_BUNDLE = Buffer.from('#!/usr/bin/env node\nruntime\n');

function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'agent-usage-claude-'));
  tempDirectories.push(home);
  const selectionConfigPath = join(home, '.agent-usage', 'config.json');
  return {
    home,
    selectionConfigPath,
    runtimeBundle: RUNTIME_BUNDLE,
    adapter: createClaudeAdapter({
      home,
      selectionConfigPath,
      runtimeBundle: RUNTIME_BUNDLE,
    }),
  };
}

function pluginRoot(home: string): string {
  return join(home, '.claude', 'skills', 'agent-usage-plugin');
}

function aliasPath(home: string): string {
  return join(home, '.claude', 'skills', 'usage-stats', 'SKILL.md');
}

async function fileMode(path: string): Promise<number> {
  const info = await stat(path);
  return info.mode & 0o777;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

describe('createClaudeAdapter', () => {
  it('exposes the claude-code id and capability set', () => {
    const { adapter } = makeFixture();
    expect(adapter.id).toBe('claude-code');
    expect(adapter.capabilities).toEqual({
      nativeSkillEvents: true,
      skillInjection: true,
      nativeMcpEvents: true,
      stdioMcpProxy: false,
      skillWatching: false,
    });
  });
});

describe('install', () => {
  it('writes plugin files, runtime, and alias, all success', async () => {
    const { adapter, home } = makeFixture();

    const results = await adapter.install('user');

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.status === 'success')).toBe(true);

    const files = claudePluginFiles();
    // Every plugin file except the alias is written under the plugin root.
    for (const [relative, content] of Object.entries(files)) {
      if (relative === 'alias/SKILL.md') continue;
      const path = join(pluginRoot(home), relative);
      expect(await readFile(path, 'utf8')).toBe(content);
    }
    // Runtime bundle copied and executable.
    const runtimePath = join(pluginRoot(home), 'runtime', 'agent-usage.mjs');
    expect(Buffer.from(await readFile(runtimePath))).toEqual(RUNTIME_BUNDLE);
    expect(await fileMode(runtimePath)).toBe(0o755);
    // Alias written at the bare skill path.
    expect(await readFile(aliasPath(home), 'utf8')).toBe(files['alias/SKILL.md']);
  });

  it('records the plugin root via discover after install', async () => {
    const { adapter } = makeFixture();

    expect(await adapter.discover()).toEqual([]);

    await adapter.install('user');

    const discovered = await adapter.discover();
    expect(discovered).toHaveLength(1);
  });

  it('reports installed coverage via health after install', async () => {
    const { adapter } = makeFixture();

    await adapter.install('user');

    const coverage = await adapter.health();
    expect(coverage.agent).toBe('claude-code');
    expect(coverage.skills).toBe('native and injected');
    expect(coverage.mcp).toBe('native');
    expect(coverage.issues).toEqual([]);
  });

  it('is idempotent: installing twice is safe with no duplicate content', async () => {
    const { adapter, home } = makeFixture();

    await adapter.install('user');
    const firstRuntime = await readFile(
      join(pluginRoot(home), 'runtime', 'agent-usage.mjs'),
    );
    const firstAlias = await readFile(aliasPath(home), 'utf8');

    const results = await adapter.install('user');
    expect(results.every((result) => result.status === 'success')).toBe(true);

    expect(
      await readFile(join(pluginRoot(home), 'runtime', 'agent-usage.mjs')),
    ).toEqual(firstRuntime);
    expect(await readFile(aliasPath(home), 'utf8')).toBe(firstAlias);
  });
});

describe('uninstall', () => {
  it('removes the plugin root and alias', async () => {
    const { adapter, home } = makeFixture();

    await adapter.install('user');
    expect(existsSync(pluginRoot(home))).toBe(true);
    expect(existsSync(aliasPath(home))).toBe(true);

    const results = await adapter.uninstall('user');
    expect(results.every((result) => result.status === 'success')).toBe(true);

    expect(existsSync(pluginRoot(home))).toBe(false);
    expect(existsSync(aliasPath(home))).toBe(false);
    expect(await adapter.discover()).toEqual([]);
  });

  it('reports unavailable coverage after uninstall', async () => {
    const { adapter } = makeFixture();

    await adapter.install('user');
    await adapter.uninstall('user');

    const coverage = await adapter.health();
    expect(coverage.skills).toBe('unavailable');
    expect(coverage.mcp).toBe('unavailable');
    expect(coverage.issues).toContain('plugin not installed');
  });

  it('leaves non-owned files inside the plugin root untouched', async () => {
    const { adapter, home } = makeFixture();

    await adapter.install('user');
    const userFile = join(pluginRoot(home), 'user-notes.txt');
    await writeFile(userFile, 'do not delete me');

    const results = await adapter.uninstall('user');

    // The plugin root is removed only if empty of owned files; a non-owned
    // file must survive and be reported as degraded so the user can review it.
    expect(existsSync(userFile)).toBe(true);
    expect(await readFile(userFile, 'utf8')).toBe('do not delete me');
    expect(results.some((result) => result.status === 'degraded')).toBe(true);
  });

  it('preserves a user-edited alias (hash mismatch) and reports degraded', async () => {
    const { adapter, home } = makeFixture();

    await adapter.install('user');
    // Simulate the user editing the alias after install.
    await writeFile(aliasPath(home), '---\nname: usage-stats\n---\nmy edits\n');

    const results = await adapter.uninstall('user');

    expect(existsSync(aliasPath(home))).toBe(true);
    expect(await readFile(aliasPath(home), 'utf8')).toContain('my edits');
    expect(results.some((result) => result.status === 'degraded')).toBe(true);
  });
});

describe('health drift', () => {
  it('reports the plugin missing when never installed', async () => {
    const { adapter } = makeFixture();

    const coverage = await adapter.health();
    expect(coverage.skills).toBe('unavailable');
    expect(coverage.mcp).toBe('unavailable');
    expect(coverage.issues).toContain('plugin not installed');
  });
});

describe('sync and repair', () => {
  it('sync reconciles to the installed state', async () => {
    const { adapter, home } = makeFixture();

    await adapter.sync('user');

    expect(existsSync(pluginRoot(home))).toBe(true);
    const coverage = await adapter.health();
    expect(coverage.skills).toBe('native and injected');
  });

  it('repair restores a missing owned file', async () => {
    const { adapter, home } = makeFixture();

    await adapter.install('user');
    const hooksPath = join(pluginRoot(home), 'hooks', 'hooks.json');
    await rm(hooksPath);
    expect(existsSync(hooksPath)).toBe(false);

    await adapter.repair('user');

    expect(existsSync(hooksPath)).toBe(true);
    expect(await sha256(hooksPath)).toBeTruthy();
  });
});

describe('read-only graceful handling', () => {
  it('install reports degraded rather than crashing on an unwritable runtime', async () => {
    const { adapter, home } = makeFixture();

    await adapter.install('user');
    const runtimePath = join(pluginRoot(home), 'runtime', 'agent-usage.mjs');
    // Make the runtime read-only so a re-install cannot chmod/overwrite cleanly.
    await chmod(runtimePath, 0o444);
    // Reinstall attempts to rewrite; ensure it does not crash.
    const results = await adapter.install('user');
    expect(results.some((r) => r.status === 'success' || r.status === 'degraded')).toBe(true);
    await chmod(runtimePath, 0o644);
  });
});
