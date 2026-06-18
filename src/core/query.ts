import type { DatabaseSync } from 'node:sqlite';

import type { UsageEvent } from './event.js';

export type NamedRange = 'today' | '7d' | '30d' | 'all';

export interface QueryFilter {
  since?: string;
  agent?: string;
  kind?: UsageEvent['kind'];
}

export interface UsageTotal {
  agent: string;
  kind: UsageEvent['kind'];
  evidence: UsageEvent['evidence'];
  precision: UsageEvent['precision'];
  count: number;
}

export interface SkillTotal {
  agent: string;
  name: string;
  count: number;
}

export interface McpTotal {
  agent: string;
  server: string;
  tool: string;
  success: number;
  failure: number;
  unknown: number;
  averageDurationMs: number | null;
}

export interface UsageReport {
  rangeLabel: string;
  totals: UsageTotal[];
  topSkills: SkillTotal[];
  mcp: McpTotal[];
  warnings: string[];
}

interface SqlFilter {
  clause: string;
  parameters: string[];
}

const INJECTED_MCP_WARNING =
  'Injected MCP skill usage is best-effort and may be incomplete.';
const JOYCODE_MCP_WARNING = 'JoyCode MCP coverage is stdio-only';

function sqlFilter(filter: QueryFilter): SqlFilter {
  const predicates: string[] = [];
  const parameters: string[] = [];

  if (filter.since !== undefined) {
    predicates.push('occurred_at >= ?');
    parameters.push(new Date(filter.since).toISOString());
  }
  if (filter.agent !== undefined) {
    predicates.push('agent = ?');
    parameters.push(filter.agent);
  }
  if (filter.kind !== undefined) {
    predicates.push('kind = ?');
    parameters.push(filter.kind);
  }

  return {
    clause: predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`,
    parameters,
  };
}

function appendPredicate(filter: SqlFilter, predicate: string): string {
  return filter.clause === ''
    ? `WHERE ${predicate}`
    : `${filter.clause} AND ${predicate}`;
}

function numeric(value: number | bigint): number {
  return Number(value);
}

export function namedRangeStart(
  range: NamedRange,
  now: Date = new Date(),
): string | undefined {
  if (range === 'all') {
    return undefined;
  }

  const start = new Date(now);
  if (range === 'today') {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(start.getDate() - (range === '7d' ? 7 : 30));
  }
  return start.toISOString();
}

export function queryUsageReport(
  database: DatabaseSync,
  filter: QueryFilter,
  rangeLabel: string,
): UsageReport {
  const sql = sqlFilter(filter);

  const totals = database
    .prepare(`
      SELECT agent, kind, evidence, precision, COUNT(*) AS count
      FROM usage_events
      ${sql.clause}
      GROUP BY agent, kind, evidence, precision
      ORDER BY agent, kind, evidence, precision
    `)
    .all(...sql.parameters)
    .map((row) => ({
      agent: row.agent as string,
      kind: row.kind as UsageEvent['kind'],
      evidence: row.evidence as UsageEvent['evidence'],
      precision: row.precision as UsageEvent['precision'],
      count: numeric(row.count as number | bigint),
    }));

  const topSkills = database
    .prepare(`
      SELECT agent, name, COUNT(*) AS count
      FROM usage_events
      ${appendPredicate(
        sql,
        "kind IN ('skill_session_load', 'skill_invocation')",
      )}
      GROUP BY agent, name
      ORDER BY count DESC, agent ASC, name ASC
      LIMIT 20
    `)
    .all(...sql.parameters)
    .map((row) => ({
      agent: row.agent as string,
      name: row.name as string,
      count: numeric(row.count as number | bigint),
    }));

  const mcp = database
    .prepare(`
      SELECT
        agent,
        mcp_server AS server,
        name AS tool,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure,
        SUM(CASE WHEN outcome = 'unknown' THEN 1 ELSE 0 END) AS unknown,
        AVG(duration_ms) AS averageDurationMs
      FROM usage_events
      ${appendPredicate(sql, "kind = 'mcp_call'")}
      GROUP BY agent, mcp_server, name
      ORDER BY agent ASC, mcp_server ASC, name ASC
    `)
    .all(...sql.parameters)
    .map((row) => ({
      agent: row.agent as string,
      server: row.server as string,
      tool: row.tool as string,
      success: numeric(row.success as number | bigint),
      failure: numeric(row.failure as number | bigint),
      unknown: numeric(row.unknown as number | bigint),
      averageDurationMs:
        row.averageDurationMs === null
          ? null
          : Number(row.averageDurationMs),
    }));

  const injectedMcp = database
    .prepare(`
      SELECT 1 AS present
      FROM usage_events
      ${appendPredicate(sql, "evidence = 'injected_mcp'")}
      LIMIT 1
    `)
    .get(...sql.parameters);

  const warnings: string[] = [];
  if (injectedMcp !== undefined) {
    warnings.push(INJECTED_MCP_WARNING);
  }
  if (filter.agent === undefined || filter.agent.toLowerCase() === 'joycode') {
    warnings.push(JOYCODE_MCP_WARNING);
  }

  return {
    rangeLabel,
    totals,
    topSkills,
    mcp,
    warnings,
  };
}
