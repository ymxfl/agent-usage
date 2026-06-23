import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createJoyCodeAdapter } from '../../../src/adapters/joycode/adapter.js';
import { joyCodePaths } from '../../../src/adapters/joycode/paths.js';
import {
  loadSelectionConfig,
  type AgentSelectionPolicy,
} from '../../../src/core/selection.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const DEPLOY_BODY = [
  '---',
  'name: deploy',
  'description: Deploy the service.',
  '---',
  'Deploy it.',
  '',
].join('\n');

const REVIEW_BODY = [
  '---',
  'name: review',
  'description: Review code.',
  '---',
  'Review the diff.',
  '',
].join('\n');

interface Fixture {
  home: string;
  cwd: string;
  usageStateDir: string;
  selectionConfigPath: string;
  paths: ReturnType<typeof joyCodePaths>;
  adapter: ReturnType<typeof createJoyCodeAdapter>;
  deployPath: string;
  reviewPath: string;
}

async function makeFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'agent-usage-joy-sel-'));
  tempDirectories.push(home);
  const cwd = mkdtempSync(join(tmpdir(), 'agent-usage-joy-sel-cwd-'));
  tempDirectories.push(cwd);
  const usageStateDir = join(home, 'state');
  const selectionConfigPath = join(home, 'config.json');
  const paths = joyCodePaths(home, cwd);

  await mkdir(join(paths.userSkills, 'deploy'), { recursive: true });
  await mkdir(join(paths.userSkills, 'review'), { recursive: true });
  const deployPath = join(paths.userSkills, 'deploy', 'SKILL.md');
  const reviewPath = join(paths.userSkills, 'review', 'SKILL.md');
  await writeFile(deployPath, DEPLOY_BODY);
  await writeFile(reviewPath, REVIEW_BODY);

  // User MCP config: a stdio server + a remote server.
  await mkdir(join(home, '.joycode'), { recursive: true });
  await writeFile(
    paths.userMcp,
    JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['gh-mcp'] },
        remote: { url: 'https://example.test/mcp' },
      },
    }),
  );

  const adapter = createJoyCodeAdapter({
    home,
    cwd,
    usageStateDir,
    selectionConfigPath,
    runtimeBundle: Buffer.from('runtime'),
  });

  return { home, cwd, usageStateDir, selectionConfigPath, paths, adapter, deployPath, reviewPath };
}

function hasBlock(content: string): boolean {
  return /<!-- agent-usage:begin v\d+ -->/.test(content);
}

describe('configure reconciliation', () => {
  it('injects only selected skills, wraps only selected stdio servers, persists policy', async () => {
    const { adapter, selectionConfigPath, deployPath, reviewPath, paths } =
      await makeFixture();

    const policy: AgentSelectionPolicy = {
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: ['github'],
    };
    await adapter.configure(policy);

    // Policy round-trips from disk.
    const config = await loadSelectionConfig(selectionConfigPath);
    expect(config.agents['joycode']).toEqual(policy);

    // deploy gets the block; review gets none.
    expect(hasBlock(await readFile(deployPath, 'utf8'))).toBe(true);
    expect(await readFile(reviewPath, 'utf8')).toBe(REVIEW_BODY);

    // github wrapped; remote untouched; usage-stats registered.
    const mcp = JSON.parse(await readFile(paths.userMcp, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[]; url?: string }>;
    };
    expect(mcp.mcpServers.github?.args?.[1]).toBe('proxy');
    expect(mcp.mcpServers.github?.args).toContain('github');
    expect(mcp.mcpServers.remote).toEqual({ url: 'https://example.test/mcp' });
    expect(mcp.mcpServers['usage-stats']).toBeDefined();
  });

  it('reports the non-stdio server in issues / coverage', async () => {
    const { adapter } = await makeFixture();
    const policy: AgentSelectionPolicy = {
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: ['github', 'remote'],
    };
    const results = await adapter.configure(policy);
    // remote is selected but cannot be proxied => surfaced somewhere.
    const coverage = await adapter.health();
    expect(
      coverage.issues.some((issue) => issue.includes('remote')),
    ).toBe(true);
    void results;
  });

  it('removes the block when a skill switches out of selection (lossless)', async () => {
    const { adapter, deployPath } = await makeFixture();

    await adapter.configure({
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: [],
    });
    expect(hasBlock(await readFile(deployPath, 'utf8'))).toBe(true);

    await adapter.configure({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: [],
    });
    expect(await readFile(deployPath, 'utf8')).toBe(DEPLOY_BODY);
    expect(hasBlock(await readFile(deployPath, 'utf8'))).toBe(false);
  });

  it('is byte-stable when re-run with the same policy', async () => {
    const { adapter, deployPath, paths } = await makeFixture();
    const policy: AgentSelectionPolicy = {
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: ['github'],
    };

    await adapter.configure(policy);
    const skillAfter = await readFile(deployPath, 'utf8');
    const mcpAfter = await readFile(paths.userMcp, 'utf8');

    await adapter.configure(policy);
    expect(await readFile(deployPath, 'utf8')).toBe(skillAfter);
    expect(await readFile(paths.userMcp, 'utf8')).toBe(mcpAfter);
  });

  it('reflects selectedMode / selected in listTargets after configure', async () => {
    const { adapter } = await makeFixture();
    await adapter.configure({
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: ['github'],
    });

    const targets = await adapter.listTargets();
    const byName = new Map(targets.skills.map((skill) => [skill.name, skill]));
    expect(byName.get('deploy')?.selectedMode).toBe('injected_mcp');
    expect(byName.get('review')?.selectedMode).toBeUndefined();
    // joycode only supports injected_mcp (no native_hook).
    expect(byName.get('deploy')?.supportedModes).toEqual(['injected_mcp']);

    const github = targets.mcp.find((server) => server.server === 'github');
    expect(github?.selected).toBe(true);
    expect(github?.transport).toBe('stdio');
    const remote = targets.mcp.find((server) => server.server === 'remote');
    expect(remote?.selected).toBe(false);
  });

  it('install/sync alone inject nothing and wrap nothing (opt-in)', async () => {
    const { adapter, deployPath, reviewPath, paths } = await makeFixture();

    await adapter.install('user');

    // No skill blocks.
    expect(hasBlock(await readFile(deployPath, 'utf8'))).toBe(false);
    expect(await readFile(reviewPath, 'utf8')).toBe(REVIEW_BODY);
    // github NOT wrapped (opt-in).
    const mcp = JSON.parse(await readFile(paths.userMcp, 'utf8')) as {
      mcpServers: Record<string, { args?: string[] }>;
    };
    expect(mcp.mcpServers.github?.args).toEqual(['gh-mcp']);
    expect(mcp.mcpServers['usage-stats']).toBeDefined();
  });

  it('an empty injected_mcp policy injects no skill blocks', async () => {
    const { adapter, deployPath } = await makeFixture();
    await adapter.configure({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: [],
    });
    expect(hasBlock(await readFile(deployPath, 'utf8'))).toBe(false);
  });
});
