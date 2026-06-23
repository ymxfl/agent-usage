import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { consumeClaudeHook } from '../../../src/adapters/claude/hook-command.js';
import type {
  AgentSelectionPolicy,
  SelectionConfig,
} from '../../../src/core/selection.js';

const deterministicDeps = {
  now: () => new Date('2026-06-22T11:00:00.000Z'),
  randomUUID: () => '00000000-0000-4000-8000-000000000004',
};

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/claude-hooks/${name}.json`, import.meta.url),
    'utf8',
  );
}

function policy(
  overrides: Partial<AgentSelectionPolicy> = {},
): AgentSelectionPolicy {
  return {
    skills: { native_hook: [], injected_mcp: [] },
    mcp: [],
    ...overrides,
  };
}

function config(selection?: AgentSelectionPolicy): SelectionConfig {
  return {
    version: 1,
    agents: selection === undefined ? {} : { 'claude-code': selection },
  };
}

function dependencies(selection?: AgentSelectionPolicy) {
  return {
    loadSelectionConfig: vi.fn(async () => config(selection)),
    insert: vi.fn(() => true),
    logError: vi.fn(),
    normalizerDependencies: deterministicDeps,
  };
}

describe('consumeClaudeHook', () => {
  it('records a selected native Skill event', async () => {
    const deps = dependencies(
      policy({
        skills: {
          native_hook: ['release-*'],
          injected_mcp: [],
        },
      }),
    );

    await expect(
      consumeClaudeHook(fixture('direct-skill'), deps),
    ).resolves.toBe('recorded');
    expect(deps.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'skill_invocation',
        name: 'release-review',
      }),
    );
  });

  it('ignores injected and unselected Skill events', async () => {
    for (const selection of [
      policy({
        skills: {
          native_hook: [],
          injected_mcp: ['release-review'],
        },
      }),
      policy(),
    ]) {
      const deps = dependencies(selection);

      await expect(
        consumeClaudeHook(fixture('direct-skill'), deps),
      ).resolves.toBe('ignored');
      expect(deps.insert).not.toHaveBeenCalled();
    }
  });

  it('records only selected MCP events', async () => {
    const selected = dependencies(
      policy({ mcp: ['github_enterprise-v2.search_*'] }),
    );
    const unselected = dependencies(policy({ mcp: ['sentry-cloud'] }));

    await expect(
      consumeClaudeHook(fixture('mcp-success'), selected),
    ).resolves.toBe('recorded');
    expect(selected.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mcp_call',
        mcpServer: 'github_enterprise-v2',
        name: 'search_repositories__advanced',
      }),
    );

    await expect(
      consumeClaudeHook(fixture('mcp-success'), unselected),
    ).resolves.toBe('ignored');
    expect(unselected.insert).not.toHaveBeenCalled();
  });

  it('logs and ignores a conflicting double-mode Skill selection', async () => {
    const deps = dependencies(
      policy({
        skills: {
          native_hook: ['release-*'],
          injected_mcp: ['release-review'],
        },
      }),
    );

    await expect(
      consumeClaudeHook(fixture('direct-skill'), deps),
    ).resolves.toBe('failed');
    expect(deps.insert).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalledWith(
      'Conflicting Claude Skill selection',
      expect.any(Error),
    );
  });

  it('records nothing for a fresh or missing policy', async () => {
    const deps = dependencies();

    await expect(
      consumeClaudeHook(fixture('direct-skill'), deps),
    ).resolves.toBe('ignored');
    expect(deps.insert).not.toHaveBeenCalled();
  });

  it('swallows malformed JSON and hook payloads', async () => {
    for (const input of ['{bad json', '{}']) {
      const deps = dependencies(policy());

      await expect(consumeClaudeHook(input, deps)).resolves.toBe('failed');
      expect(deps.insert).not.toHaveBeenCalled();
      expect(deps.logError).toHaveBeenCalled();
    }
  });

  it('swallows policy-load and insert errors', async () => {
    const loadFailure = dependencies(policy());
    loadFailure.loadSelectionConfig.mockRejectedValue(new Error('load failed'));

    await expect(
      consumeClaudeHook(fixture('direct-skill'), loadFailure),
    ).resolves.toBe('failed');
    expect(loadFailure.insert).not.toHaveBeenCalled();

    const insertFailure = dependencies(
      policy({
        skills: {
          native_hook: ['release-review'],
          injected_mcp: [],
        },
      }),
    );
    insertFailure.insert.mockImplementation(() => {
      throw new Error('insert failed');
    });

    await expect(
      consumeClaudeHook(fixture('direct-skill'), insertFailure),
    ).resolves.toBe('failed');
    expect(insertFailure.logError).toHaveBeenCalled();
  });

  it('swallows diagnostic logging failures', async () => {
    const deps = dependencies(policy());
    deps.logError.mockImplementation(() => {
      throw new Error('log failed');
    });

    await expect(consumeClaudeHook('{bad json', deps)).resolves.toBe('failed');
  });
});
