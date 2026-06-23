import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeAdapter } from '../../../src/adapters/claude/adapter.js';
import { hasManagedBlock } from '../../../src/adapters/claude/managed-block.js';
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

const REVIEW_BODY = [
  '---',
  'name: review',
  'description: Review code.',
  '---',
  'Review the diff.',
  '',
].join('\n');

const DEPLOY_BODY = [
  '---',
  'name: deploy',
  'description: Deploy the service.',
  '---',
  'Deploy it.',
  '',
].join('\n');

const OBSERVE_BODY = [
  '---',
  'name: observe',
  'description: Observe metrics.',
  '---',
  'Observe them.',
  '',
].join('\n');

interface Fixture {
  home: string;
  selectionConfigPath: string;
  adapter: ReturnType<typeof createClaudeAdapter>;
  reviewPath: string;
  deployPath: string;
  observePath: string;
}

async function makeFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'agent-usage-sel-'));
  tempDirectories.push(home);
  const skillsRoot = join(home, '.claude', 'skills');
  await mkdir(join(skillsRoot, 'review'), { recursive: true });
  await mkdir(join(skillsRoot, 'deploy'), { recursive: true });
  await mkdir(join(skillsRoot, 'observe'), { recursive: true });
  const reviewPath = join(skillsRoot, 'review', 'SKILL.md');
  const deployPath = join(skillsRoot, 'deploy', 'SKILL.md');
  const observePath = join(skillsRoot, 'observe', 'SKILL.md');
  await writeFile(reviewPath, REVIEW_BODY);
  await writeFile(deployPath, DEPLOY_BODY);
  await writeFile(observePath, OBSERVE_BODY);

  const selectionConfigPath = join(home, '.agent-usage', 'config.json');
  return {
    home,
    selectionConfigPath,
    adapter: createClaudeAdapter({
      home,
      selectionConfigPath,
      runtimeBundle: Buffer.from('runtime'),
    }),
    reviewPath,
    deployPath,
    observePath,
  };
}

describe('listTargets', () => {
  it('discovers user skills with both supported modes and no selection under an empty policy', async () => {
    const { adapter } = await makeFixture();

    const targets = await adapter.listTargets();

    expect(targets.agent).toBe('claude-code');
    const names = targets.skills.map((skill) => skill.name).sort();
    expect(names).toEqual(['deploy', 'observe', 'review']);
    for (const skill of targets.skills) {
      expect(skill.scope).toBe('user');
      expect(skill.supportedModes).toEqual(['native_hook', 'injected_mcp']);
      expect(skill.selectedMode).toBeUndefined();
    }
    expect(targets.mcp).toEqual([]);
    expect(targets.unresolved).toEqual([]);
  });

  it('excludes the managed plugin and alias directories from discovery', async () => {
    const { adapter, home } = await makeFixture();
    // Create the managed dirs so we can prove they are excluded.
    await mkdir(join(home, '.claude', 'skills', 'agent-usage-plugin'), {
      recursive: true,
    });
    await mkdir(join(home, '.claude', 'skills', 'usage-stats'), {
      recursive: true,
    });

    const targets = await adapter.listTargets();

    const names = targets.skills.map((skill) => skill.name);
    expect(names).not.toContain('agent-usage-plugin');
    expect(names).not.toContain('usage-stats');
  });

  it('reads mcpServers from ~/.claude.json as stdio transports', async () => {
    const { adapter, home } = await makeFixture();
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: [] },
          'remote-api': { type: 'sse' },
        },
      }),
    );

    const targets = await adapter.listTargets();

    const servers = targets.mcp.map((server) => server.server).sort();
    expect(servers).toEqual(['github', 'remote-api']);
    const github = targets.mcp.find((server) => server.server === 'github');
    expect(github?.transport).toBe('stdio');
    expect(github?.selected).toBe(false);
  });

  it('returns an empty MCP list when ~/.claude.json is absent', async () => {
    const { adapter } = await makeFixture();
    const targets = await adapter.listTargets();
    expect(targets.mcp).toEqual([]);
  });
});

describe('configure reconciliation', () => {
  it('persists the policy and injects exactly one block into injected_mcp skills only', async () => {
    const { adapter, selectionConfigPath, reviewPath, deployPath, observePath } =
      await makeFixture();

    const policy: AgentSelectionPolicy = {
      skills: { native_hook: ['review'], injected_mcp: ['deploy'] },
      mcp: [],
    };

    await adapter.configure(policy);

    // Policy round-trips from disk.
    const config = await loadSelectionConfig(selectionConfigPath);
    expect(config.agents['claude-code']).toEqual(policy);

    // deploy (injected_mcp) gets exactly one block.
    const deployContent = await readFile(deployPath, 'utf8');
    expect(hasManagedBlock(deployContent)).toBe(true);
    expect(deployContent.match(/agent-usage:begin/g)).toHaveLength(1);

    // review (native_hook) gets no block.
    const reviewContent = await readFile(reviewPath, 'utf8');
    expect(hasManagedBlock(reviewContent)).toBe(false);

    // observe (unselected) stays byte-identical.
    expect(await readFile(observePath, 'utf8')).toBe(OBSERVE_BODY);
  });

  it('is byte-stable when re-run with the same policy (no duplicate blocks)', async () => {
    const { adapter, deployPath } = await makeFixture();
    const policy: AgentSelectionPolicy = {
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: [],
    };

    await adapter.configure(policy);
    const afterFirst = await readFile(deployPath, 'utf8');
    await adapter.configure(policy);
    const afterSecond = await readFile(deployPath, 'utf8');

    expect(afterSecond).toBe(afterFirst);
    expect(hasManagedBlock(afterSecond)).toBe(true);
  });

  it('removes the block when a skill switches from injected_mcp back to native_hook', async () => {
    const { adapter, deployPath } = await makeFixture();

    await adapter.configure({
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: [],
    });
    expect(hasManagedBlock(await readFile(deployPath, 'utf8'))).toBe(true);

    await adapter.configure({
      skills: { native_hook: ['deploy'], injected_mcp: [] },
      mcp: [],
    });

    expect(await readFile(deployPath, 'utf8')).toBe(DEPLOY_BODY);
    expect(hasManagedBlock(await readFile(deployPath, 'utf8'))).toBe(false);
  });

  it('removes the block when a skill becomes unselected', async () => {
    const { adapter, deployPath } = await makeFixture();

    await adapter.configure({
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: [],
    });
    await adapter.configure({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: [],
    });

    expect(await readFile(deployPath, 'utf8')).toBe(DEPLOY_BODY);
  });

  it('reflects the new selectedMode in listTargets after configure', async () => {
    const { adapter } = await makeFixture();
    const policy: AgentSelectionPolicy = {
      skills: { native_hook: ['review'], injected_mcp: ['deploy'] },
      mcp: [],
    };

    await adapter.configure(policy);

    const targets = await adapter.listTargets();
    const byName = new Map(targets.skills.map((skill) => [skill.name, skill]));
    expect(byName.get('review')?.selectedMode).toBe('native_hook');
    expect(byName.get('deploy')?.selectedMode).toBe('injected_mcp');
    expect(byName.get('observe')?.selectedMode).toBeUndefined();
  });

  it('reports degraded without crashing when a selected injected skill is read-only', async () => {
    const { adapter, reviewPath } = await makeFixture();
    // review selected for injection, but its file is read-only.
    await writeFile(reviewPath, REVIEW_BODY, { mode: 0o444 });
    await chmod(reviewPath, 0o444);

    const results = await adapter.configure({
      skills: { native_hook: [], injected_mcp: ['review'] },
      mcp: [],
    });

    expect(results.some((result) => result.status === 'degraded')).toBe(true);
    // File is untouched (still the original, no block).
    expect(hasManagedBlock(await readFile(reviewPath, 'utf8'))).toBe(false);
    await chmod(reviewPath, 0o644);
  });

  it('clears all selections with an empty policy and strips any existing block', async () => {
    const { adapter, deployPath } = await makeFixture();

    await adapter.configure({
      skills: { native_hook: [], injected_mcp: ['deploy'] },
      mcp: [],
    });
    expect(hasManagedBlock(await readFile(deployPath, 'utf8'))).toBe(true);

    await adapter.configure({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: [],
    });

    expect(await readFile(deployPath, 'utf8')).toBe(DEPLOY_BODY);
  });
});
