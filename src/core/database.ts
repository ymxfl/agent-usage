import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SUPPORTED_SCHEMA_VERSION = 1;

function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;

  return row?.user_version ?? 0;
}

function migrateToVersionOne(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      agent TEXT NOT NULL,
      session_id TEXT,
      project TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      skill_id TEXT,
      mcp_server TEXT,
      outcome TEXT NOT NULL,
      duration_ms INTEGER,
      evidence TEXT NOT NULL,
      precision TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX usage_events_occurred_at_idx
      ON usage_events (occurred_at);
    CREATE INDEX usage_events_agent_kind_idx
      ON usage_events (agent, kind);
    PRAGMA user_version = 1;
  `);
}

function applyMigrations(database: DatabaseSync, currentVersion: number): void {
  if (currentVersion >= SUPPORTED_SCHEMA_VERSION) {
    return;
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    if (currentVersion === 0) {
      migrateToVersionOne(database);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function openUsageDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);

  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 1000;
      PRAGMA foreign_keys = ON;
    `);

    const currentVersion = schemaVersion(database);
    if (currentVersion > SUPPORTED_SCHEMA_VERSION) {
      throw new Error(
        `Usage database schema ${currentVersion} is newer than supported schema ${SUPPORTED_SCHEMA_VERSION}`,
      );
    }

    applyMigrations(database, currentVersion);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
