import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UsageEvent } from '../../src/core/event.js';
import { namedRangeStart, type UsageReport } from '../../src/core/query.js';
import {
  UsageMcpService,
  type UsageMcpRepository,
} from '../../src/mcp/service.js';

const emptyReport: UsageReport = {
  rangeLabel: '7d',
  totals: [],
  topSkills: [],
  mcp: [],
  warnings: [],
};

function repositorySpy(overrides: Partial<UsageMcpRepository> = {}): {
  events: UsageEvent[];
  repository: UsageMcpRepository;
  report: ReturnType<typeof vi.fn<UsageMcpRepository['report']>>;
} {
  const events: UsageEvent[] = [];
  const dedupeKeys = new Set<string>();
  const report = vi.fn<UsageMcpRepository['report']>(() => emptyReport);

  return {
    events,
    report,
    repository: {
      insert(event) {
        if (dedupeKeys.has(event.dedupeKey)) {
          return false;
        }
        dedupeKeys.add(event.dedupeKey);
        events.push(event);
        return true;
      },
      report,
      ...overrides,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageMcpService.recordSkill', () => {
  it('records every skill call on the same connection', () => {
    const fixture = repositorySpy();
    const service = new UsageMcpService(
      fixture.repository,
      'codex',
      'connection-1',
    );

    expect(service.recordSkill({ skill_id: 'skill-1', skill_name: 'Testing' })).toEqual({
      ok: true,
      recorded: true,
      next: 'continue',
    });
    expect(service.recordSkill({ skill_id: 'skill-1', skill_name: 'Testing' })).toEqual({
      ok: true,
      recorded: true,
      next: 'continue',
    });
    expect(fixture.events).toHaveLength(2);
  });

  it('records the same skill for a different connection', () => {
    const fixture = repositorySpy();
    const first = new UsageMcpService(fixture.repository, 'codex', 'connection-1');
    const second = new UsageMcpService(fixture.repository, 'codex', 'connection-2');

    expect(first.recordSkill({ skill_id: 'skill-1' }).recorded).toBe(true);
    expect(second.recordSkill({ skill_id: 'skill-1' }).recorded).toBe(true);
    expect(fixture.events.map(({ dedupeKey }) => dedupeKey)).toEqual([
      'injected:connection-1:skill-1:1',
      'injected:connection-2:skill-1:1',
    ]);
  });

  it('records two different skills on one connection', () => {
    const fixture = repositorySpy();
    const service = new UsageMcpService(fixture.repository, 'codex', 'connection-1');

    expect(service.recordSkill({ skill_id: 'skill-1' }).recorded).toBe(true);
    expect(service.recordSkill({ skill_id: 'skill-2' }).recorded).toBe(true);
    expect(fixture.events.map(({ skillId }) => skillId)).toEqual([
      'skill-1',
      'skill-2',
    ]);
  });

  it('normalizes exact accounting metadata without prompt content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T09:30:00.000Z'));
    const fixture = repositorySpy();
    const service = new UsageMcpService(fixture.repository, 'claude', 'connection-1');

    service.recordSkill({
      skill_id: 'claude:user:skill-1',
      skill_name: 'test-driven-development',
      scope: 'user',
    });

    expect(fixture.events).toEqual([
      {
        schemaVersion: 1,
        occurredAt: '2026-06-18T09:30:00.000Z',
        agent: 'claude',
        sessionId: 'connection-1',
        kind: 'skill_session_load',
        name: 'test-driven-development',
        skillId: 'claude:user:skill-1',
        outcome: 'unknown',
        evidence: 'injected_mcp',
        precision: 'best_effort',
        dedupeKey: 'injected:connection-1:claude:user:skill-1:1',
      },
    ]);
    expect(fixture.events[0]).not.toHaveProperty('prompt');
  });

  it('uses the skill id as the default name', () => {
    const fixture = repositorySpy();
    const service = new UsageMcpService(fixture.repository, 'codex', 'connection-1');

    service.recordSkill({ skill_id: 'skill-1' });

    expect(fixture.events[0]?.name).toBe('skill-1');
  });

  it('fails open and logs storage errors without asking the caller to retry', () => {
    const storageError = new Error('database unavailable');
    const error = vi.fn();
    const fixture = repositorySpy({
      insert() {
        throw storageError;
      },
    });
    const service = new UsageMcpService(
      fixture.repository,
      'codex',
      'connection-1',
      { error },
    );

    expect(service.recordSkill({ skill_id: 'skill-1' })).toEqual({
      ok: false,
      recorded: false,
      next: 'continue',
    });
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      'Failed to record injected skill usage',
      storageError,
    );
  });
});

describe('UsageMcpService.queryNamedRange', () => {
  it.each(['today', '7d', '30d', 'all'] as const)(
    'queries the %s named range using the current time',
    (range) => {
      vi.useFakeTimers();
      const now = new Date(2026, 5, 18, 15, 45, 30, 125);
      vi.setSystemTime(now);
      const fixture = repositorySpy();
      const service = new UsageMcpService(
        fixture.repository,
        'codex',
        'connection-1',
      );

      expect(service.queryNamedRange({ range })).toBe(emptyReport);
      expect(fixture.report).toHaveBeenCalledWith(
        range === 'all' ? {} : { since: namedRangeStart(range, now) },
        range,
      );
    },
  );

  it('defaults to 7d and forwards optional agent and kind filters', () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-18T09:30:00.000Z');
    vi.setSystemTime(now);
    const fixture = repositorySpy();
    const service = new UsageMcpService(fixture.repository, 'codex', 'connection-1');

    service.queryNamedRange({
      agent: 'claude',
      kind: 'skill_session_load',
    });

    expect(fixture.report).toHaveBeenCalledWith(
      {
        since: namedRangeStart('7d', now),
        agent: 'claude',
        kind: 'skill_session_load',
      },
      '7d',
    );
  });
});
