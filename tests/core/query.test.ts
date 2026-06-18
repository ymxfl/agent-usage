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
          'JoyCode MCP usage is unavailable because JoyCode supports stdio MCP servers only.',
        ],
      });
      expect(fixture.repository.report({ agent: 'codex' }, 'all time').warnings).toEqual([]);
      expect(fixture.repository.report({ agent: 'joycode' }, 'all time').warnings).toEqual([
        'JoyCode MCP usage is unavailable because JoyCode supports stdio MCP servers only.',
      ]);
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
          count: 1,
        },
      ]);
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
