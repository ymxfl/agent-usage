import { describe, expect, it } from 'vitest';

import { normalizeCodexHook } from '../../../src/adapters/codex/normalize.js';

const occurredAt = '2026-06-28T10:15:00.000Z';
const deps = { now: () => new Date(occurredAt) };

const base = {
  hook_event_name: 'PostToolUse',
  session_id: 'codex-session-1',
  cwd: '/Users/joshua/work/payments-api',
  tool_use_id: 'call-1',
  tool_name: 'mcp__dom-pointer__get-pointed-element',
  duration_ms: 12,
};

describe('normalizeCodexHook', () => {
  it('normalizes Codex MCP success events from native hooks', () => {
    expect(normalizeCodexHook(base, deps)).toEqual({
      schemaVersion: 1,
      occurredAt,
      agent: 'codex',
      sessionId: 'codex-session-1',
      project: 'payments-api',
      kind: 'mcp_call',
      mcpServer: 'dom-pointer',
      name: 'get-pointed-element',
      outcome: 'success',
      durationMs: 12,
      evidence: 'native_hook',
      precision: 'exact',
      dedupeKey: 'codex:native:call-1',
    });
  });

  it('normalizes Codex MCP failure events', () => {
    expect(
      normalizeCodexHook(
        {
          ...base,
          hook_event_name: 'PostToolUseFailure',
          tool_use_id: 'call-2',
        },
        deps,
      ),
    ).toMatchObject({
      outcome: 'failure',
      dedupeKey: 'codex:native:call-2',
    });
  });

  it('accepts event as an alias for hook_event_name', () => {
    const { hook_event_name: _hook, ...withoutEvent } = base;

    expect(
      normalizeCodexHook(
        { ...withoutEvent, event: 'PostToolUse' },
        deps,
      ),
    ).toMatchObject({
      mcpServer: 'dom-pointer',
      name: 'get-pointed-element',
    });
  });

  it('ignores non-MCP tools and accounting MCP servers', () => {
    expect(normalizeCodexHook({ ...base, tool_name: 'Read' }, deps)).toBeNull();
    expect(
      normalizeCodexHook(
        { ...base, tool_name: 'mcp__usage-stats__record_skill' },
        deps,
      ),
    ).toBeNull();
  });
});
