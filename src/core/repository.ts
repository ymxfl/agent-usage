import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { UsageEvent } from './event.js';

export class UsageRepository {
  readonly #database: DatabaseSync;
  readonly #insertStatement: StatementSync;
  readonly #countStatement: StatementSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
    this.#insertStatement = database.prepare(`
      INSERT OR IGNORE INTO usage_events (
        schema_version,
        occurred_at,
        agent,
        session_id,
        project,
        kind,
        name,
        skill_id,
        mcp_server,
        outcome,
        duration_ms,
        evidence,
        precision,
        dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#countStatement = database.prepare(
      'SELECT COUNT(*) AS count FROM usage_events',
    );
  }

  insert(event: UsageEvent): boolean {
    const result = this.#insertStatement.run(
      event.schemaVersion,
      event.occurredAt,
      event.agent,
      event.sessionId ?? null,
      event.project ?? null,
      event.kind,
      event.name,
      event.skillId ?? null,
      event.mcpServer ?? null,
      event.outcome,
      event.durationMs ?? null,
      event.evidence,
      event.precision,
      event.dedupeKey,
    );

    return result.changes === 1 || result.changes === 1n;
  }

  count(): number {
    const row = this.#countStatement.get() as { count: number | bigint };
    return Number(row.count);
  }
}
