import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openUsageDatabase } from '../../src/core/database.js';
import {
  namedRangeStart,
  type NamedRange,
} from '../../src/core/query.js';
import { UsageRepository } from '../../src/core/repository.js';
import { usageEvent } from '../helpers/usage-fixtures.js';

const temporaryDirectories: string[] = [];

async function repositoryFixture(): Promise<{
  close: () => void;
  repository: UsageRepository;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-usage-query-'));
  temporaryDirectories.push(directory);
  const database = openUsageDatabase(join(directory, 'usage.db'));
  return {
    close: () => database.close(),
    repository: new UsageRepository(database),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('namedRangeStart', () => {
  const now = new Date(2026, 5, 18, 15, 45, 30, 125);

  it.each([
    ['today', new Date(2026, 5, 18).toISOString()],
    ['7d', new Date(2026, 5, 11, 15, 45, 30, 125).toISOString()],
    ['30d', new Date(2026, 4, 19, 15, 45, 30, 125).toISOString()],
    ['all', undefined],
  ] satisfies Array<[NamedRange, string | undefined]>)('%s has the expected start', (range, expected) => {
    expect(namedRangeStart(range, now)).toBe(expected);
  });
});

describe('UsageRepository.report', () => {
  it('returns empty aggregates and the applicable JoyCode coverage warning', async () => {
    const fixture = await repositoryFixture();

    try {
      expect(fixture.repository.report({}, 'all time')).toEqual({
        rangeLabel: 'all time',
        totals: [],
        topSkills: [],
        mcp: [],
        warnings: [
          'JoyCode MCP coverage is stdio-only',
        ],
      });
      expect(fixture.repository.report({ agent: 'codex' }, 'all time').warnings).toEqual([]);
      expect(fixture.repository.report({ agent: 'joycode' }, 'all time').warnings).toEqual([
        'JoyCode MCP coverage is stdio-only',
      ]);
    } finally {
      fixture.close();
    }
  });

  it.each([
    ['today', 1],
    ['7d', 2],
    ['30d', 3],
    ['all', 4],
  ] satisfies Array<[NamedRange, number]>)('applies the %s range to stored events', async (range, expectedCount) => {
    const fixture = await repositoryFixture();
    const now = new Date(2026, 5, 18, 15, 45, 30, 125);
    const timestamps = [
      new Date(2026, 5, 18, 12, 0, 0, 0),
      new Date(2026, 5, 11, 16, 0, 0, 0),
      new Date(2026, 4, 20, 12, 0, 0, 0),
      new Date(2026, 4, 1, 12, 0, 0, 0),
    ];

    try {
      for (const occurredAt of timestamps) {
        fixture.repository.insert(usageEvent({
          occurredAt: occurredAt.toISOString(),
        }));
      }

      const since = namedRangeStart(range, now);
      const report = fixture.repository.report(
        since === undefined ? {} : { since },
        range,
      );

      expect(report.rangeLabel).toBe(range);
      expect(report.totals).toEqual([
        expect.objectContaining({ count: expectedCount }),
      ]);
      expect(report.topSkills).toEqual([
        expect.objectContaining({ count: expectedCount }),
      ]);
      expect(report.mcp).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('groups totals with evidence and applies since, agent, and kind filters', async () => {
    const fixture = await repositoryFixture();

    try {
      fixture.repository.insert(usageEvent({
        occurredAt: '2026-06-17T08:00:00.000Z',
        agent: 'codex',
        kind: 'skill_invocation',
        evidence: 'native_hook',
      }));
      fixture.repository.insert(usageEvent({
        occurredAt: '2026-06-18T08:00:00.000Z',
        agent: 'codex',
        kind: 'skill_invocation',
        evidence: 'native_hook',
      }));
      fixture.repository.insert(usageEvent({
        occurredAt: '2026-06-18T09:00:00.000Z',
        agent: 'claude',
        kind: 'skill_invocation',
        evidence: 'native_hook',
      }));
      fixture.repository.insert(usageEvent({
        occurredAt: '2026-06-18T10:00:00.000Z',
        agent: 'codex',
        kind: 'skill_session_load',
        evidence: 'native_hook',
      }));

      expect(fixture.repository.report({
        since: '2026-06-18T00:00:00.000Z',
        agent: 'codex',
        kind: 'skill_invocation',
      }, 'today').totals).toEqual([
        {
          agent: 'codex',
          kind: 'skill_invocation',
          evidence: 'native_hook',
          precision: 'exact',
          count: 1,
        },
      ]);
    } finally {
      fixture.close();
    }
  });

  it('includes an event at the same instant across fractional timestamp precision', async () => {
    const fixture = await repositoryFixture();

    try {
      fixture.repository.insert(usageEvent({
        occurredAt: '2026-06-18T09:30:00.10Z',
      }));

      const report = fixture.repository.report(
        { since: '2026-06-18T09:30:00.1Z' },
        'custom',
      );

      expect(report.totals).toEqual([
        expect.objectContaining({ count: 1 }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it('canonicalizes offset since filters and rejects invalid timestamps', async () => {
    const fixture = await repositoryFixture();

    try {
      fixture.repository.insert(usageEvent({
        occurredAt: '2026-06-18T09:30:00.000Z',
      }));

      expect(
        fixture.repository.report(
          { since: '2026-06-18T10:30:00+01:00' },
          'custom',
        ).totals,
      ).toEqual([expect.objectContaining({ count: 1 })]);
      expect(() =>
        fixture.repository.report({ since: 'not-an-instant' }, 'custom'),
      ).toThrow(RangeError);
    } finally {
      fixture.close();
    }
  });

  it('parameterizes SQL-like agent filters', async () => {
    const fixture = await repositoryFixture();

    try {
      fixture.repository.insert(usageEvent({ agent: 'codex' }));
      fixture.repository.insert(usageEvent({ agent: "codex' OR 1=1 --" }));

      const report = fixture.repository.report(
        { agent: "codex' OR 1=1 --" },
        'all time',
      );

      expect(report.totals).toEqual([
        expect.objectContaining({ agent: "codex' OR 1=1 --", count: 1 }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it('applies an agent filter consistently to totals, skills, and MCP calls', async () => {
    const fixture = await repositoryFixture();

    try {
      for (const agent of ['codex', 'claude']) {
        fixture.repository.insert(usageEvent({
          agent,
          kind: 'skill_invocation',
          name: `${agent}-skill`,
        }));
        fixture.repository.insert(usageEvent({
          agent,
          kind: 'mcp_call',
          name: `${agent}-tool`,
          mcpServer: `${agent}-server`,
          skillId: undefined,
          evidence: 'mcp_proxy',
        }));
      }

      const report = fixture.repository.report({ agent: 'codex' }, 'all time');

      expect(report.totals.map(({ agent }) => agent)).toEqual(['codex', 'codex']);
      expect(report.topSkills).toEqual([
        expect.objectContaining({ agent: 'codex', name: 'codex-skill' }),
      ]);
      expect(report.mcp).toEqual([
        expect.objectContaining({
          agent: 'codex',
          server: 'codex-server',
          tool: 'codex-tool',
        }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it('applies kind filters consistently and intentionally suppresses other categories', async () => {
    const fixture = await repositoryFixture();

    try {
      fixture.repository.insert(usageEvent({
        kind: 'skill_invocation',
        name: 'invoked-skill',
      }));
      fixture.repository.insert(usageEvent({
        kind: 'skill_session_load',
        name: 'loaded-skill',
      }));
      fixture.repository.insert(usageEvent({
        kind: 'mcp_call',
        name: 'issues/list',
        mcpServer: 'github',
        skillId: undefined,
        evidence: 'mcp_proxy',
      }));

      const skills = fixture.repository.report(
        { kind: 'skill_invocation' },
        'all time',
      );
      expect(skills.totals).toEqual([
        expect.objectContaining({ kind: 'skill_invocation', count: 1 }),
      ]);
      expect(skills.topSkills).toEqual([
        expect.objectContaining({ name: 'invoked-skill', count: 1 }),
      ]);
      expect(skills.mcp).toEqual([]);

      const mcp = fixture.repository.report({ kind: 'mcp_call' }, 'all time');
      expect(mcp.totals).toEqual([
        expect.objectContaining({ kind: 'mcp_call', count: 1 }),
      ]);
      expect(mcp.topSkills).toEqual([]);
      expect(mcp.mcp).toEqual([
        expect.objectContaining({ server: 'github', tool: 'issues/list' }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it('ranks both skill kinds by agent/name, with stable ties and a top-20 limit', async () => {
    const fixture = await repositoryFixture();

    try {
      fixture.repository.insert(usageEvent({
        agent: 'codex',
        kind: 'skill_invocation',
        name: 'combined-skill',
      }));
      fixture.repository.insert(usageEvent({
        agent: 'codex',
        kind: 'skill_session_load',
        name: 'combined-skill',
      }));
      for (let index = 0; index < 21; index += 1) {
        fixture.repository.insert(usageEvent({
          agent: 'claude',
          kind: 'skill_invocation',
          name: `tied-skill-${String(index).padStart(2, '0')}`,
        }));
      }

      const report = fixture.repository.report({}, 'all time');

      expect(report.topSkills).toHaveLength(20);
      expect(report.topSkills[0]).toEqual({
        agent: 'codex',
        name: 'combined-skill',
        count: 2,
      });
      expect(report.topSkills.slice(1).map(({ name }) => name)).toEqual(
        Array.from({ length: 19 }, (_, index) =>
          `tied-skill-${String(index).padStart(2, '0')}`,
        ),
      );
    } finally {
      fixture.close();
    }
  });

  it('groups MCP outcomes, preserves null averages, and does not suppress unfiltered MCP rows', async () => {
    const fixture = await repositoryFixture();

    try {
      for (const [outcome, durationMs] of [
        ['success', 10],
        ['success', 20],
        ['failure', null],
        ['unknown', null],
      ] as const) {
        fixture.repository.insert(usageEvent({
          kind: 'mcp_call',
          name: 'issues/list',
          mcpServer: 'github',
          skillId: undefined,
          outcome,
          durationMs: durationMs ?? undefined,
          evidence: 'mcp_proxy',
        }));
      }
      fixture.repository.insert(usageEvent({
        kind: 'mcp_call',
        name: 'search',
        mcpServer: 'web',
        skillId: undefined,
        outcome: 'unknown',
        durationMs: undefined,
        evidence: 'mcp_proxy',
      }));

      const report = fixture.repository.report({ agent: 'codex' }, 'all time');

      expect(report.mcp).toEqual([
        {
          agent: 'codex',
          server: 'github',
          tool: 'issues/list',
          success: 2,
          failure: 1,
          unknown: 1,
          averageDurationMs: 15,
        },
        {
          agent: 'codex',
          server: 'web',
          tool: 'search',
          success: 0,
          failure: 0,
          unknown: 1,
          averageDurationMs: null,
        },
      ]);
      expect(fixture.repository.report({
        agent: 'codex',
        kind: 'skill_invocation',
      }, 'all time').mcp).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('reports filtered injected-MCP data as best effort', async () => {
    const fixture = await repositoryFixture();

    try {
      fixture.repository.insert(usageEvent({
        agent: 'codex',
        evidence: 'injected_mcp',
        precision: 'best_effort',
      }));
      fixture.repository.insert(usageEvent({
        agent: 'claude',
        evidence: 'native_hook',
      }));

      expect(fixture.repository.report({ agent: 'codex' }, 'all time').warnings).toEqual([
        'Injected MCP skill usage is best-effort and may be incomplete.',
      ]);
      expect(fixture.repository.report({ agent: 'claude' }, 'all time').warnings).toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
