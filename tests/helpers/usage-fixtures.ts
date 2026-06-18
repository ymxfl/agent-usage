import type { UsageEvent } from '../../src/core/event.js';

let fixtureSequence = 0;

export function usageEvent(
  overrides: Partial<UsageEvent> = {},
): UsageEvent {
  fixtureSequence += 1;

  const event = {
    schemaVersion: 1,
    occurredAt: '2026-06-18T09:30:00.000Z',
    agent: 'codex',
    kind: 'skill_invocation',
    name: 'test-driven-development',
    skillId: 'codex:project:test-driven-development',
    outcome: 'success',
    evidence: 'native_hook',
    precision: 'exact',
    dedupeKey: `fixture:${fixtureSequence}`,
    ...overrides,
  };

  return event as UsageEvent;
}
