import { describe, expect, it, vi } from 'vitest';

import { consumeCodexHook } from '../../../src/adapters/codex/hook-command.js';
import type {
  AgentSelectionPolicy,
  SelectionConfig,
} from '../../../src/core/selection.js';

const hook = JSON.stringify({
  hook_event_name: 'PostToolUse',
  session_id: 'codex-session-1',
  cwd: '/Users/joshua/work/payments-api',
  tool_use_id: 'call-1',
  tool_name: 'mcp__dom-pointer__get-pointed-element',
});

const depsBase = {
  normalizerDependencies: {
    now: () => new Date('2026-06-28T10:15:00.000Z'),
  },
};

function policy(overrides: Partial<AgentSelectionPolicy> = {}): AgentSelectionPolicy {
  return {
    skills: { native_hook: [], injected_mcp: [] },
    mcp: [],
    ...overrides,
  };
}

function config(selection?: AgentSelectionPolicy): SelectionConfig {
  return {
    version: 1,
    agents: selection === undefined ? {} : { codex: selection },
  };
}

function deps(selection?: AgentSelectionPolicy) {
  return {
    loadSelectionConfig: vi.fn(async () => config(selection)),
    insert: vi.fn(() => true),
    logError: vi.fn(),
    ...depsBase,
  };
}

describe('consumeCodexHook', () => {
  it('records selected MCP calls', async () => {
    const selected = deps(policy({ mcp: ['dom-pointer.get-*'] }));

    await expect(consumeCodexHook(hook, selected)).resolves.toBe('recorded');
    expect(selected.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        kind: 'mcp_call',
        mcpServer: 'dom-pointer',
        name: 'get-pointed-element',
      }),
    );
  });

  it('ignores unselected MCP calls', async () => {
    const unselected = deps(policy({ mcp: ['github'] }));

    await expect(consumeCodexHook(hook, unselected)).resolves.toBe('ignored');
    expect(unselected.insert).not.toHaveBeenCalled();
  });

  it('fails open on malformed input', async () => {
    const malformed = deps(policy());

    await expect(consumeCodexHook('{bad json', malformed)).resolves.toBe('failed');
    expect(malformed.insert).not.toHaveBeenCalled();
    expect(malformed.logError).toHaveBeenCalled();
  });
});
