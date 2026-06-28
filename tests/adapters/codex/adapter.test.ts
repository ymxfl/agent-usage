import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCodexAdapter } from '../../../src/adapters/codex/adapter.js';

const tempDirectories: string[] = [];
const RUNTIME_BUNDLE = Buffer.from('#!/usr/bin/env node\nruntime\n');

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-usage-codex-'));
  tempDirectories.push(home);
  const selectionConfigPath = join(home, '.agent-usage', 'config.json');
  const usageStateDir = join(home, '.agent-usage', 'state');
  const usageDatabasePath = join(home, '.agent-usage', 'usage.db');
  const adapter = createCodexAdapter({
    home,
    selectionConfigPath,
    usageStateDir,
    usageDatabasePath,
    runtimeBundle: RUNTIME_BUNDLE,
  });
  return { adapter, home, selectionConfigPath };
}

async function seedSkill(home: string, name: string, content?: string): Promise<string> {
  const skillDir = join(home, '.codex', 'skills', name);
  await mkdir(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  await writeFile(
    skillFile,
    content ?? `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`,
  );
  return skillFile;
}

describe('createCodexAdapter', () => {
  it('exposes Codex capabilities', () => {
    const { adapter } = makeFixture();

    expect(adapter.id).toBe('codex');
    expect(adapter.capabilities).toEqual({
      nativeSkillEvents: false,
      skillInjection: true,
      nativeMcpEvents: true,
      stdioMcpProxy: false,
      skillWatching: false,
    });
  });

  it('lists only user skills under ~/.codex/skills and skips hidden roots', async () => {
    const { adapter, home } = makeFixture();
    await seedSkill(home, 'pointed');
    await seedSkill(home, '.system');

    const targets = await adapter.listTargets();

    expect(targets.agent).toBe('codex');
    expect(targets.skills.map((skill) => skill.name)).toEqual(['pointed']);
    expect(targets.skills[0]).toMatchObject({
      scope: 'user',
      supportedModes: ['injected_mcp'],
    });
  });

  it('persists selection and injects only selected skills', async () => {
    const { adapter, home, selectionConfigPath } = makeFixture();
    const pointed = await seedSkill(home, 'pointed');
    const deploy = await seedSkill(home, 'deploy');

    const results = await adapter.configure({
      skills: { native_hook: [], injected_mcp: ['pointed'] },
      mcp: ['dom-pointer.*'],
    });

    expect(results.every((result) => result.status !== 'failed')).toBe(true);
    expect(await readFile(pointed, 'utf8')).toContain('record_skill');
    expect(await readFile(pointed, 'utf8')).toContain('"skill_name":"pointed"');
    expect(await readFile(deploy, 'utf8')).not.toContain('agent-usage:begin');
    expect(JSON.parse(await readFile(selectionConfigPath, 'utf8'))).toMatchObject({
      agents: {
        codex: {
          skills: { injected_mcp: ['pointed'] },
          mcp: ['dom-pointer.*'],
        },
      },
    });
  });

  it('discovers concrete MCP servers from ~/.codex/config.toml', async () => {
    const { adapter, home } = makeFixture();
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.dom-pointer]',
        'args = ["server.mjs"]',
        'command = "node"',
        '',
        '[mcp_servers.dom-pointer.env]',
        'MCP_POINTER_PORT = "7007"',
        '',
        '[mcp_servers.github]',
        'url = "https://example.com/mcp"',
        '',
        '[mcp_servers.github.tools.search]',
        'approval_mode = "approve"',
        '',
        '[mcp_servers.usage-stats]',
        'command = "node"',
        'args = ["agent-usage.mjs", "mcp"]',
        '',
      ].join('\n'),
    );

    const targets = await adapter.listTargets();

    expect(targets.mcp).toEqual([
      {
        server: 'dom-pointer',
        scope: 'user',
        transport: 'stdio',
        selected: false,
      },
      {
        server: 'github',
        scope: 'user',
        transport: 'http',
        selected: false,
      },
    ]);
  });

  it('installs runtime, Codex hooks, and usage-stats MCP config', async () => {
    const { adapter, home } = makeFixture();

    const results = await adapter.install('user');

    expect(results.every((result) => result.status !== 'failed')).toBe(true);
    const runtime = join(home, '.codex', 'agent-usage', 'runtime', 'agent-usage.mjs');
    expect(Buffer.from(await readFile(runtime))).toEqual(RUNTIME_BUNDLE);
    expect((await stat(runtime)).mode & 0o777).toBe(0o755);

    const hooks = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8'));
    expect(hooks.hooks.PostToolUse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matcher: '^mcp__.*',
          hooks: [
            expect.objectContaining({
              type: 'command',
              command: expect.stringContaining('hook codex'),
            }),
          ],
        }),
      ]),
    );
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.usage-stats]',
    );
  });
});
