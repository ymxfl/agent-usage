import { describe, expect, it } from 'vitest';

import { parseUsageEvent } from '../../src/core/event.js';

const baseEvent = {
  schemaVersion: 1,
  occurredAt: '2026-06-18T09:30:00.000Z',
  agent: 'codex',
  kind: 'skill_invocation',
  name: 'test-driven-development',
  skillId: 'codex:project:0123456789abcdef',
  outcome: 'success',
  evidence: 'native_hook',
  precision: 'exact',
  dedupeKey: 'codex:native:tool-456',
} as const;

describe('parseUsageEvent', () => {
  it('parses a valid metadata-only usage event', () => {
    const event = {
      ...baseEvent,
      sessionId: 'session-123',
      project: 'agent-usage',
      durationMs: 42,
    };

    expect(parseUsageEvent(event)).toEqual(event);
  });

  it('parses a valid MCP call event', () => {
    const { skillId: _, ...withoutSkillId } = baseEvent;
    const event = {
      ...withoutSkillId,
      kind: 'mcp_call',
      name: 'tools/call',
      mcpServer: 'github',
      evidence: 'mcp_proxy',
    } as const;

    expect(parseUsageEvent(event)).toEqual(event);
  });

  it('rejects unknown properties so content cannot enter the event', () => {
    expect(() => parseUsageEvent({ ...baseEvent, prompt: 'secret' })).toThrow();
  });

  it.each(['skill_session_load', 'skill_invocation'] as const)(
    'requires skillId for %s events',
    (kind) => {
      const { skillId: _, ...withoutSkillId } = baseEvent;

      expect(() => parseUsageEvent({ ...withoutSkillId, kind })).toThrow();
    },
  );

  it.each(['skill_session_load', 'skill_invocation'] as const)(
    'rejects an empty skillId for %s events',
    (kind) => {
      expect(() => parseUsageEvent({ ...baseEvent, kind, skillId: '' })).toThrow();
    },
  );

  it('requires mcpServer for mcp_call events', () => {
    const { skillId: _, ...withoutSkillId } = baseEvent;

    expect(() =>
      parseUsageEvent({ ...withoutSkillId, kind: 'mcp_call', name: 'tools/call' }),
    ).toThrow();
  });

  it('rejects an empty mcpServer for mcp_call events', () => {
    const { skillId: _, ...withoutSkillId } = baseEvent;

    expect(() =>
      parseUsageEvent({
        ...withoutSkillId,
        kind: 'mcp_call',
        name: 'tools/call',
        mcpServer: '',
      }),
    ).toThrow();
  });

  it.each(['sessionId', 'project'] as const)(
    'rejects an empty optional %s',
    (field) => {
      expect(() => parseUsageEvent({ ...baseEvent, [field]: '' })).toThrow();
    },
  );

  it.each([
    ['kind', 'skill_started'],
    ['outcome', 'partial'],
    ['evidence', 'log_scan'],
    ['precision', 'estimated'],
  ] as const)('rejects values outside the %s enum', (field, value) => {
    expect(() => parseUsageEvent({ ...baseEvent, [field]: value })).toThrow();
  });
});
