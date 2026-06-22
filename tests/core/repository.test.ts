import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { openUsageDatabase } from '../../src/core/database.js';
import type { UsageEvent } from '../../src/core/event.js';
import { usagePaths } from '../../src/core/paths.js';
import { UsageRepository } from '../../src/core/repository.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-usage-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function runConcurrentWriter(file: string, prefix: string): Promise<void> {
  const databaseModule = pathToFileURL(
    join(process.cwd(), 'src', 'core', 'database.ts'),
  ).href;
  const repositoryModule = pathToFileURL(
    join(process.cwd(), 'src', 'core', 'repository.ts'),
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `
      const { registerHooks } = await import('node:module');
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
            return nextResolve(specifier.slice(0, -3) + '.ts', context);
          }
          return nextResolve(specifier, context);
        },
      });
      const { openUsageDatabase } = await import(process.env.DATABASE_MODULE);
      const { UsageRepository } = await import(process.env.REPOSITORY_MODULE);
      const database = openUsageDatabase(process.env.DATABASE_FILE);
      const repository = new UsageRepository(database);

      for (let index = 0; index < 25; index += 1) {
        repository.insert({
          schemaVersion: 1,
          occurredAt: '2026-06-18T09:30:00.000Z',
          agent: 'codex',
          kind: 'skill_invocation',
          name: 'test-driven-development',
          skillId: 'codex:project:0123456789abcdef',
          outcome: 'success',
          evidence: 'native_hook',
          precision: 'exact',
          dedupeKey: \`\${process.env.WRITER_PREFIX}:\${index}\`,
        });
      }

      database.close();
    `,
    ],
    {
      env: {
        ...process.env,
        DATABASE_FILE: file,
        DATABASE_MODULE: databaseModule,
        REPOSITORY_MODULE: repositoryModule,
        WRITER_PREFIX: prefix,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Concurrent SQLite writer ${prefix} timed out`));
    }, 10_000);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Concurrent SQLite writer ${prefix} exited ${code}: ${stderr}`,
          ),
        );
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

const baseEvent = {
  schemaVersion: 1,
  occurredAt: '2026-06-18T09:30:00.000Z',
  agent: 'codex',
  name: 'test-driven-development',
  outcome: 'success',
  evidence: 'native_hook',
  precision: 'exact',
  dedupeKey: 'codex:native:tool-456',
} as const;

const eventVariants: UsageEvent[] = [
  {
    ...baseEvent,
    kind: 'skill_session_load',
    skillId: 'codex:project:0123456789abcdef',
  },
  {
    ...baseEvent,
    kind: 'skill_invocation',
    skillId: 'codex:project:0123456789abcdef',
    sessionId: 'session-123',
    project: 'agent-usage',
    durationMs: 42.5,
    mcpServer: 'injected-skill-tracker',
    evidence: 'injected_mcp',
    precision: 'best_effort',
    dedupeKey: 'injected:connection-1:skill-1',
  },
  {
    ...baseEvent,
    kind: 'mcp_call',
    name: 'tools/call',
    mcpServer: 'github',
    evidence: 'mcp_proxy',
    dedupeKey: 'proxy:connection-1:1',
  },
];

describe('usagePaths', () => {
  it('uses an explicit root override', () => {
    expect(usagePaths('/tmp/custom-agent-usage')).toEqual({
      root: '/tmp/custom-agent-usage',
      config: '/tmp/custom-agent-usage/config.json',
      database: '/tmp/custom-agent-usage/usage.db',
      state: '/tmp/custom-agent-usage/state',
      errors: '/tmp/custom-agent-usage/logs/errors.log',
    });
  });

  it('defaults to AGENT_USAGE_HOME and then the user home', () => {
    const previous = process.env.AGENT_USAGE_HOME;

    try {
      process.env.AGENT_USAGE_HOME = '/tmp/environment-agent-usage';
      expect(usagePaths()).toEqual({
        root: '/tmp/environment-agent-usage',
        config: '/tmp/environment-agent-usage/config.json',
        database: '/tmp/environment-agent-usage/usage.db',
        state: '/tmp/environment-agent-usage/state',
        errors: '/tmp/environment-agent-usage/logs/errors.log',
      });

      delete process.env.AGENT_USAGE_HOME;
      expect(usagePaths()).toEqual({
        root: join(homedir(), '.agent-usage'),
        config: join(homedir(), '.agent-usage', 'config.json'),
        database: join(homedir(), '.agent-usage', 'usage.db'),
        state: join(homedir(), '.agent-usage', 'state'),
        errors: join(homedir(), '.agent-usage', 'logs', 'errors.log'),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_USAGE_HOME;
      } else {
        process.env.AGENT_USAGE_HOME = previous;
      }
    }
  });
});

describe('openUsageDatabase', () => {
  it('creates the parent directory and configures the connection', async () => {
    const root = await temporaryDirectory();
    const file = join(root, 'nested', 'usage.db');

    const database = openUsageDatabase(file);

    try {
      expect(existsSync(dirname(file))).toBe(true);
      expect(database.prepare('PRAGMA journal_mode').get()).toEqual({
        journal_mode: 'wal',
      });
      expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({
        timeout: 1000,
      });
      expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({
        foreign_keys: 1,
      });
      expect(database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 1,
      });
    } finally {
      database.close();
    }
  });

  it('applies the v1 table and required indexes', async () => {
    const root = await temporaryDirectory();
    const database = openUsageDatabase(join(root, 'usage.db'));

    try {
      const columns = database
        .prepare(
          "SELECT name, type FROM pragma_table_info('usage_events') ORDER BY cid",
        )
        .all() as Array<{ name: string; type: string }>;
      expect(columns.map(({ name }) => name)).toEqual([
        'id',
        'schema_version',
        'occurred_at',
        'agent',
        'session_id',
        'project',
        'kind',
        'name',
        'skill_id',
        'mcp_server',
        'outcome',
        'duration_ms',
        'evidence',
        'precision',
        'dedupe_key',
      ]);
      expect(columns.find(({ name }) => name === 'duration_ms')?.type).toBe(
        'REAL',
      );

      const indexes = database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND tbl_name = 'usage_events'
             AND name NOT LIKE 'sqlite_autoindex%'
           ORDER BY name`,
        )
        .all()
        .map(({ name }) => name);
      expect(indexes).toEqual(['usage_events_agent_kind', 'usage_events_time']);
    } finally {
      database.close();
    }
  });

  it('rejects databases newer than the supported schema', async () => {
    const root = await temporaryDirectory();
    const file = join(root, 'usage.db');
    const futureDatabase = new DatabaseSync(file);
    futureDatabase.exec('PRAGMA user_version = 2');
    futureDatabase.close();

    expect(() => openUsageDatabase(file)).toThrow(/newer.*schema|schema.*newer/i);
  });
});

describe('UsageRepository', () => {
  it('canonicalizes accepted event timestamps at the storage boundary', async () => {
    const root = await temporaryDirectory();
    const database = openUsageDatabase(join(root, 'usage.db'));
    const repository = new UsageRepository(database);

    try {
      repository.insert({
        ...baseEvent,
        occurredAt: '2026-06-18T09:30:00.10Z',
        kind: 'skill_invocation',
        skillId: 'codex:project:0123456789abcdef',
      });

      expect(
        database
          .prepare('SELECT occurred_at AS occurredAt FROM usage_events')
          .get(),
      ).toEqual({ occurredAt: '2026-06-18T09:30:00.100Z' });
    } finally {
      database.close();
    }
  });

  it.each(eventVariants)('inserts and roundtrips a $kind event', async (event) => {
    const root = await temporaryDirectory();
    const database = openUsageDatabase(join(root, 'usage.db'));
    const repository = new UsageRepository(database);

    try {
      expect(repository.insert(event)).toBe(true);
      expect(repository.count()).toBe(1);

      expect(
        database
          .prepare(
            `SELECT
              schema_version AS schemaVersion,
              occurred_at AS occurredAt,
              agent,
              session_id AS sessionId,
              project,
              kind,
              name,
              skill_id AS skillId,
              mcp_server AS mcpServer,
              outcome,
              duration_ms AS durationMs,
              evidence,
              precision,
              dedupe_key AS dedupeKey
            FROM usage_events`,
          )
          .get(),
      ).toEqual({
        schemaVersion: event.schemaVersion,
        occurredAt: event.occurredAt,
        agent: event.agent,
        sessionId: event.sessionId ?? null,
        project: event.project ?? null,
        kind: event.kind,
        name: event.name,
        skillId: event.skillId ?? null,
        mcpServer: event.mcpServer ?? null,
        outcome: event.outcome,
        durationMs: event.durationMs ?? null,
        evidence: event.evidence,
        precision: event.precision,
        dedupeKey: event.dedupeKey,
      });

      const columns = database
        .prepare("SELECT name FROM pragma_table_info('usage_events')")
        .all()
        .map(({ name }) => name);
      expect(columns).not.toContain('prompt');
      expect(columns).not.toContain('args');
    } finally {
      database.close();
    }
  });

  it('ignores duplicate dedupe keys', async () => {
    const root = await temporaryDirectory();
    const database = openUsageDatabase(join(root, 'usage.db'));
    const repository = new UsageRepository(database);
    const event = eventVariants[0]!;

    try {
      expect(repository.insert(event)).toBe(true);
      expect(repository.insert({ ...event, name: 'changed name' })).toBe(false);
      expect(repository.count()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('allows two WAL connections to write without corruption', async () => {
    const root = await temporaryDirectory();
    const file = join(root, 'usage.db');

    await Promise.all([
      runConcurrentWriter(file, 'first'),
      runConcurrentWriter(file, 'second'),
    ]);

    const database = openUsageDatabase(file);
    try {
      expect(new UsageRepository(database).count()).toBe(50);
      expect(database.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      database.close();
    }
  });
});
