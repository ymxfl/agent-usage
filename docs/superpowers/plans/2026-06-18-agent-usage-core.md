# Agent Usage Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent-neutral event store, MCP accounting server, stdio MCP proxy, reporting engine, CLI, and adapter contracts.

**Architecture:** A bundled TypeScript CLI normalizes all observations into a versioned SQLite schema. The same executable runs as a maintenance CLI, an MCP server, a Claude hook consumer, or a transparent stdio MCP proxy; platform-specific discovery and mutation live behind adapters added in later plans.

**Tech Stack:** Node.js 24+, TypeScript 5, built-in `node:sqlite`, `@modelcontextprotocol/sdk` 1.29, Zod 4, Commander 15, Vitest 4, esbuild.

---

## File Map

- `package.json`: package metadata, scripts, runtime dependencies, and CLI entrypoint.
- `tsconfig.json`: strict TypeScript configuration.
- `vitest.config.ts`: deterministic unit/integration test setup.
- `scripts/build.mjs`: bundle the runtime into one distributable ESM file.
- `src/version.ts`: schema and application version constants.
- `src/core/event.ts`: normalized event types and validation.
- `src/core/identity.ts`: stable Skill and deduplication IDs.
- `src/core/database.ts`: SQLite location, migrations, WAL configuration, and transactions.
- `src/core/repository.ts`: insert and query boundary.
- `src/core/query.ts`: report filters and aggregations.
- `src/core/paths.ts`: data/state/log path resolution.
- `src/report/text.ts`: terminal report rendering.
- `src/mcp/service.ts`: transport-independent `record_skill` and `query_usage` behavior.
- `src/mcp/server.ts`: MCP server registration and stdio transport.
- `src/proxy/protocol.ts`: MCP JSON-RPC observation without message mutation.
- `src/proxy/stdio-proxy.ts`: child-process relay and lifecycle.
- `src/adapters/types.ts`: capability and lifecycle contracts.
- `src/adapters/registry.ts`: adapter registration and lookup.
- `src/cli.ts`: command routing.
- `tests/**`: unit and integration fixtures matching each source file.

### Task 1: Bootstrap a Strict, Bundled TypeScript CLI

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `scripts/build.mjs`
- Create: `src/version.ts`
- Create: `tests/version.test.ts`

- [ ] **Step 1: Write the failing version smoke test**

```ts
// tests/version.test.ts
import { describe, expect, it } from 'vitest';
import { APP_VERSION, EVENT_SCHEMA_VERSION } from '../src/version.js';

describe('version constants', () => {
  it('exposes explicit application and event schema versions', () => {
    expect(APP_VERSION).toBe('0.1.0');
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Add package and compiler configuration**

```json
// package.json
{
  "name": "agent-usage",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "agent-usage": "dist/agent-usage.mjs" },
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "check": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "commander": "^15.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "^0.27.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.9"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', restoreMocks: true } });
```

- [ ] **Step 3: Install dependencies and verify the test fails**

Run: `npm install && npm test -- tests/version.test.ts`

Expected: FAIL because `src/version.ts` does not exist.

- [ ] **Step 4: Add the minimal version module and bundle script**

```ts
// src/version.ts
export const APP_VERSION = '0.1.0';
export const EVENT_SCHEMA_VERSION = 1;
```

```js
// scripts/build.mjs
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/agent-usage.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
});
```

- [ ] **Step 5: Run smoke verification**

Run: `npm test -- tests/version.test.ts && npm run check`

Expected: PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the scaffold**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts scripts/build.mjs src/version.ts tests/version.test.ts
git commit -m "chore: scaffold agent usage runtime"
```

### Task 2: Define the Versioned Event and Identity Model

**Files:**
- Create: `src/core/event.ts`
- Create: `src/core/identity.ts`
- Create: `tests/core/event.test.ts`
- Create: `tests/core/identity.test.ts`

- [ ] **Step 1: Write failing schema and stable-ID tests**

```ts
// tests/core/event.test.ts
import { describe, expect, it } from 'vitest';
import { parseUsageEvent } from '../../src/core/event.js';

describe('parseUsageEvent', () => {
  it('accepts metadata-only events and rejects captured payload content', () => {
    expect(parseUsageEvent({
      schemaVersion: 1,
      occurredAt: '2026-06-18T00:00:00.000Z',
      agent: 'joycode',
      kind: 'skill_session_load',
      name: 'deploy',
      skillId: 'joycode:user:abc',
      outcome: 'unknown',
      evidence: 'injected_mcp',
      precision: 'best_effort',
      dedupeKey: 'joycode:connection-1:joycode:user:abc'
    }).agent).toBe('joycode');

    expect(() => parseUsageEvent({ prompt: 'secret' })).toThrow();
  });
});
```

```ts
// tests/core/identity.test.ts
import { expect, it } from 'vitest';
import { stableSkillId } from '../../src/core/identity.js';

it('distinguishes same-name Skills in different scopes without exposing full paths', () => {
  const user = stableSkillId('joycode', 'user', '/Users/me/.joycode/skills/deploy');
  const project = stableSkillId('joycode', 'project', '/work/app/.joycode/skills/deploy');
  expect(user).toMatch(/^joycode:user:[a-f0-9]{16}$/);
  expect(project).not.toBe(user);
  expect(user).not.toContain('/Users/me');
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/core/event.test.ts tests/core/identity.test.ts`

Expected: FAIL because the core modules do not exist.

- [ ] **Step 3: Implement the minimal event schema and identity helpers**

```ts
// src/core/event.ts
import { z } from 'zod';

export const usageEventSchema = z.object({
  schemaVersion: z.literal(1),
  occurredAt: z.string().datetime(),
  agent: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  kind: z.enum(['skill_session_load', 'skill_invocation', 'mcp_call']),
  name: z.string().min(1),
  skillId: z.string().min(1).optional(),
  mcpServer: z.string().min(1).optional(),
  outcome: z.enum(['success', 'failure', 'unknown']),
  durationMs: z.number().nonnegative().optional(),
  evidence: z.enum(['native_hook', 'injected_mcp', 'mcp_proxy']),
  precision: z.enum(['exact', 'best_effort']),
  dedupeKey: z.string().min(1),
}).strict().superRefine((value, context) => {
  if (value.kind.startsWith('skill_') && !value.skillId) {
    context.addIssue({ code: 'custom', path: ['skillId'], message: 'Skill events require skillId' });
  }
  if (value.kind === 'mcp_call' && !value.mcpServer) {
    context.addIssue({ code: 'custom', path: ['mcpServer'], message: 'MCP events require mcpServer' });
  }
});

export type UsageEvent = z.infer<typeof usageEventSchema>;
export const parseUsageEvent = (input: unknown): UsageEvent => usageEventSchema.parse(input);
```

```ts
// src/core/identity.ts
import { createHash } from 'node:crypto';

export type Scope = 'user' | 'project';

export function stableSkillId(agent: string, scope: Scope, canonicalPath: string): string {
  const digest = createHash('sha256').update(`${agent}\0${scope}\0${canonicalPath}`).digest('hex').slice(0, 16);
  return `${agent}:${scope}:${digest}`;
}

export const nativeDedupeKey = (agent: string, toolUseId: string) => `${agent}:native:${toolUseId}`;
export const injectedDedupeKey = (connectionId: string, skillId: string) => `injected:${connectionId}:${skillId}`;
export const proxyDedupeKey = (connectionId: string, requestId: string | number) => `proxy:${connectionId}:${requestId}`;
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/core/event.test.ts tests/core/identity.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the event contract**

```bash
git add src/core/event.ts src/core/identity.ts tests/core/event.test.ts tests/core/identity.test.ts
git commit -m "feat: define normalized usage events"
```

### Task 3: Add SQLite WAL Storage and Idempotent Inserts

**Files:**
- Create: `src/core/paths.ts`
- Create: `src/core/database.ts`
- Create: `src/core/repository.ts`
- Create: `tests/core/repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

```ts
// tests/core/repository.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openUsageDatabase } from '../../src/core/database.js';
import { UsageRepository } from '../../src/core/repository.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('UsageRepository', () => {
  it('uses WAL and ignores duplicate dedupe keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-usage-'));
    dirs.push(dir);
    const db = openUsageDatabase(join(dir, 'usage.db'));
    const repo = new UsageRepository(db);
    const event = {
      schemaVersion: 1 as const,
      occurredAt: '2026-06-18T00:00:00.000Z', agent: 'joycode',
      kind: 'skill_session_load' as const, name: 'deploy', skillId: 'joycode:user:1',
      outcome: 'unknown' as const, evidence: 'injected_mcp' as const,
      precision: 'best_effort' as const, dedupeKey: 'same'
    };
    expect(repo.insert(event)).toBe(true);
    expect(repo.insert(event)).toBe(false);
    expect(repo.count()).toBe(1);
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    db.close();
  });
});
```

- [ ] **Step 2: Run the repository test to verify RED**

Run: `npm test -- tests/core/repository.test.ts`

Expected: FAIL because database modules do not exist.

- [ ] **Step 3: Implement paths, migration, and repository**

```ts
// src/core/paths.ts
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface UsagePaths { root: string; database: string; state: string; errors: string }
export function usagePaths(root = process.env.AGENT_USAGE_HOME ?? join(homedir(), '.agent-usage')): UsagePaths {
  return { root, database: join(root, 'usage.db'), state: join(root, 'state'), errors: join(root, 'logs', 'errors.log') };
}
```

```ts
// src/core/database.ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openUsageDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS usage_events (
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
      duration_ms REAL,
      evidence TEXT NOT NULL,
      precision TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS usage_events_time ON usage_events(occurred_at);
    CREATE INDEX IF NOT EXISTS usage_events_agent_kind ON usage_events(agent, kind);
  `);
  return db;
}
```

```ts
// src/core/repository.ts
import type { DatabaseSync } from 'node:sqlite';
import type { UsageEvent } from './event.js';

export class UsageRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(event: UsageEvent): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO usage_events
      (schema_version, occurred_at, agent, session_id, project, kind, name, skill_id,
       mcp_server, outcome, duration_ms, evidence, precision, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.schemaVersion, event.occurredAt, event.agent, event.sessionId ?? null,
        event.project ?? null, event.kind, event.name, event.skillId ?? null,
        event.mcpServer ?? null, event.outcome, event.durationMs ?? null,
        event.evidence, event.precision, event.dedupeKey);
    return result.changes === 1;
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }).count);
  }
}
```

- [ ] **Step 4: Verify storage behavior and concurrency**

Run: `npm test -- tests/core/repository.test.ts && npm run check`

Expected: PASS with one stored row after duplicate insertion.

- [ ] **Step 5: Commit storage**

```bash
git add src/core/paths.ts src/core/database.ts src/core/repository.ts tests/core/repository.test.ts
git commit -m "feat: persist usage events in sqlite"
```

### Task 4: Implement Aggregation and Text Reporting

**Files:**
- Create: `src/core/query.ts`
- Create: `src/report/text.ts`
- Create: `tests/core/query.test.ts`
- Create: `tests/report/text.test.ts`

- [ ] **Step 1: Write failing aggregation and rendering tests**

```ts
// tests/report/text.test.ts
import { expect, it } from 'vitest';
import { renderUsageReport } from '../../src/report/text.js';

it('labels evidence and transport limitations', () => {
  const text = renderUsageReport({
    rangeLabel: 'Last 7 days',
    totals: [{ agent: 'joycode', kind: 'skill_session_load', evidence: 'injected_mcp', count: 2 }],
    skills: [{ agent: 'joycode', name: 'deploy', count: 2 }],
    mcp: [{ agent: 'joycode', server: 'github', tool: 'search', success: 3, failure: 1, unknown: 0, averageDurationMs: 25 }],
    warnings: ['JoyCode Skill counts are best-effort', 'JoyCode MCP coverage is stdio-only']
  });
  expect(text).toContain('best-effort');
  expect(text).toContain('stdio-only');
  expect(text).toContain('github.search');
});
```

- [ ] **Step 2: Run report tests to verify RED**

Run: `npm test -- tests/core/query.test.ts tests/report/text.test.ts`

Expected: FAIL because query and renderer modules do not exist.

- [ ] **Step 3: Implement concrete query result types and renderer**

```ts
// src/core/query.ts
import type { DatabaseSync } from 'node:sqlite';

export interface QueryFilter { since?: string; agent?: string; kind?: string }
export interface UsageReport {
  rangeLabel: string;
  totals: Array<{ agent: string; kind: string; evidence: string; count: number }>;
  skills: Array<{ agent: string; name: string; count: number }>;
  mcp: Array<{ agent: string; server: string; tool: string; success: number; failure: number; unknown: number; averageDurationMs: number }>;
  warnings: string[];
}

export function namedRangeStart(range: 'today' | '7d' | '30d' | 'all', now: Date): string | undefined {
  if (range === 'all') return undefined;
  const start = new Date(now);
  if (range === 'today') start.setHours(0, 0, 0, 0);
  else start.setDate(start.getDate() - (range === '7d' ? 7 : 30));
  return start.toISOString();
}

export function queryUsage(db: DatabaseSync, filter: QueryFilter, rangeLabel: string): UsageReport {
  const clauses = ['1 = 1']; const params: string[] = [];
  if (filter.since) { clauses.push('occurred_at >= ?'); params.push(filter.since); }
  if (filter.agent) { clauses.push('agent = ?'); params.push(filter.agent); }
  if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
  const where = clauses.join(' AND ');
  const totals = db.prepare(`SELECT agent, kind, evidence, COUNT(*) count FROM usage_events WHERE ${where} GROUP BY agent, kind, evidence`).all(...params) as UsageReport['totals'];
  const skills = db.prepare(`SELECT agent, name, COUNT(*) count FROM usage_events WHERE ${where} AND kind IN ('skill_session_load','skill_invocation') GROUP BY agent, name ORDER BY count DESC LIMIT 20`).all(...params) as UsageReport['skills'];
  const mcp = db.prepare(`SELECT agent, mcp_server server, name tool,
    SUM(outcome='success') success, SUM(outcome='failure') failure,
    SUM(outcome='unknown') unknown, COALESCE(AVG(duration_ms), 0) averageDurationMs
    FROM usage_events WHERE ${where} AND kind='mcp_call'
    GROUP BY agent, mcp_server, name`).all(...params) as UsageReport['mcp'];
  const warnings = totals.some((row) => row.evidence === 'injected_mcp') ? ['JoyCode Skill counts are best-effort'] : [];
  if (!filter.agent || filter.agent === 'joycode') warnings.push('JoyCode MCP coverage is stdio-only');
  return { rangeLabel, totals, skills, mcp, warnings };
}
```

```ts
// src/report/text.ts
import type { UsageReport } from '../core/query.js';

export function renderUsageReport(report: UsageReport): string {
  const lines = [`Usage statistics — ${report.rangeLabel}`, ''];
  for (const row of report.totals) lines.push(`${row.agent} ${row.kind}: ${row.count} [${row.evidence}]`);
  if (report.skills.length) lines.push('', 'Skills:', ...report.skills.map((row) => `- ${row.agent}.${row.name}: ${row.count}`));
  if (report.mcp.length) lines.push('', 'MCP tools:');
  for (const row of report.mcp) lines.push(`- ${row.server}.${row.tool}: ${row.success + row.failure + row.unknown} (${row.success} ok, ${row.failure} failed, ${row.unknown} unknown, avg ${Math.round(row.averageDurationMs)} ms)`);
  if (report.warnings.length) lines.push('', 'Coverage:', ...report.warnings.map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Add fixtures covering `today`, `7d`, `30d`, `all`, Agent, and kind filters**

```ts
// tests/core/query.test.ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { queryUsage } from '../../src/core/query.js';

let db: DatabaseSync;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-18T12:00:00Z')); db = fixtureDatabase([
  fixtureEvent({ occurredAt: '2026-06-18T08:00:00Z', agent: 'claude-code', kind: 'skill_invocation', name: 'review' }),
  fixtureEvent({ occurredAt: '2026-05-01T08:00:00Z', agent: 'joycode', kind: 'skill_session_load', name: 'deploy' })
]); });
afterEach(() => { db.close(); vi.useRealTimers(); });

it.each([
  [{ since: '2026-06-18T00:00:00Z' }, 1],
  [{ since: '2026-06-11T12:00:00Z', agent: 'claude-code' }, 1],
  [{}, 2]
])('filters deterministic ranges', (filter, expected) => {
  expect(queryUsage(db, filter, 'range').skills.reduce((sum, row) => sum + row.count, 0)).toBe(expected);
});
```

Add `fixtureDatabase` and `fixtureEvent` in `tests/helpers/usage-fixtures.ts`; they must create the real schema and insert only normalized metadata.

- [ ] **Step 5: Verify report tests**

Run: `npm test -- tests/core/query.test.ts tests/report/text.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 6: Commit reporting**

```bash
git add src/core/query.ts src/report/text.ts tests/core/query.test.ts tests/report/text.test.ts
git commit -m "feat: aggregate and render usage statistics"
```

### Task 5: Expose Loop-Safe MCP Accounting Tools

**Files:**
- Create: `src/mcp/service.ts`
- Create: `src/mcp/server.ts`
- Create: `tests/mcp/service.test.ts`

- [ ] **Step 1: Write failing service tests for connection-scoped deduplication**

```ts
// tests/mcp/service.test.ts
import { expect, it } from 'vitest';
import { UsageMcpService } from '../../src/mcp/service.js';

it('records one Skill load per connection and returns success for duplicates', () => {
  const inserted: string[] = [];
  const service = new UsageMcpService({ insert: (event: { dedupeKey: string }) => { inserted.push(event.dedupeKey); return inserted.length === 1; } } as never, 'joycode', 'connection-1');
  expect(service.recordSkill({ skill_id: 'joycode:user:abc', skill_name: 'deploy' }).recorded).toBe(true);
  expect(service.recordSkill({ skill_id: 'joycode:user:abc', skill_name: 'deploy' })).toMatchObject({ ok: true, recorded: false, next: 'continue' });
  expect(inserted).toHaveLength(2); // repository receives both; UNIQUE dedupe decides persistence
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/mcp/service.test.ts`

Expected: FAIL because the MCP service does not exist.

- [ ] **Step 3: Implement transport-independent service methods**

```ts
// src/mcp/service.ts
import { randomUUID } from 'node:crypto';
import type { UsageRepository } from '../core/repository.js';
import { injectedDedupeKey } from '../core/identity.js';
import { namedRangeStart, queryUsage, type QueryFilter } from '../core/query.js';

export class UsageMcpService {
  constructor(private readonly repository: UsageRepository, private readonly agent: string, private readonly connectionId = randomUUID()) {}

  recordSkill(input: { skill_id: string; skill_name?: string; scope?: string }) {
    const recorded = this.repository.insert({
      schemaVersion: 1, occurredAt: new Date().toISOString(), agent: this.agent,
      sessionId: this.connectionId, kind: 'skill_session_load',
      name: input.skill_name ?? input.skill_id, skillId: input.skill_id,
      outcome: 'unknown', evidence: 'injected_mcp', precision: 'best_effort',
      dedupeKey: injectedDedupeKey(this.connectionId, input.skill_id)
    });
    return { ok: true, recorded, next: 'continue' as const };
  }

  queryUsage(filter: QueryFilter, rangeLabel: string) { return this.repository.report(filter, rangeLabel); }

  queryNamedRange(input: { range: 'today' | '7d' | '30d' | 'all'; agent?: string; kind?: string }) {
    const since = namedRangeStart(input.range, new Date());
    return this.queryUsage({ ...(since ? { since } : {}), ...(input.agent ? { agent: input.agent } : {}), ...(input.kind ? { kind: input.kind } : {}) }, input.range);
  }
}
```

Add this public repository method:

```ts
report(filter: QueryFilter, rangeLabel: string): UsageReport {
  return queryUsage(this.db, filter, rangeLabel);
}
```

- [ ] **Step 4: Register `record_skill` and `query_usage` on an MCP stdio server**

```ts
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { UsageMcpService } from './service.js';

export async function runUsageMcpServer(service: UsageMcpService): Promise<void> {
  const server = new McpServer({ name: 'usage-stats', version: '0.1.0' });
  server.registerTool('record_skill', {
    description: 'Record the first load of a Skill in this agent session',
    inputSchema: { skill_id: z.string(), skill_name: z.string().optional(), scope: z.string().optional() }
  }, async (input) => {
    const result = service.recordSkill(input);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool('query_usage', {
    description: 'Query local Skill and MCP usage metadata',
    inputSchema: { range: z.enum(['today', '7d', '30d', 'all']).default('7d'), agent: z.string().optional(), kind: z.string().optional() }
  }, async (input) => {
    const result = service.queryNamedRange(input);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 5: Verify duplicate handling and MCP server type checking**

Run: `npm test -- tests/mcp/service.test.ts && npm run check`

Expected: PASS; duplicate result is successful and `recorded: false`.

- [ ] **Step 6: Commit the MCP service**

```bash
git add src/mcp/service.ts src/mcp/server.ts src/core/repository.ts tests/mcp/service.test.ts
git commit -m "feat: expose usage accounting mcp tools"
```

### Task 6: Build a Transparent stdio MCP Proxy

**Files:**
- Create: `src/proxy/protocol.ts`
- Create: `src/proxy/stdio-proxy.ts`
- Create: `tests/fixtures/fake-mcp-server.mjs`
- Create: `tests/proxy/protocol.test.ts`
- Create: `tests/proxy/stdio-proxy.test.ts`

- [ ] **Step 1: Write failing protocol-observer tests**

```ts
// tests/proxy/protocol.test.ts
import { expect, it } from 'vitest';
import { McpProtocolObserver } from '../../src/proxy/protocol.js';

it('matches tools/call requests with success, error, and unfinished outcomes', () => {
  const events: Array<{ outcome: string; name: string }> = [];
  const observer = new McpProtocolObserver('joycode', 'github', 'connection-1', (event) => events.push(event));
  observer.fromClient('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"secret":"not stored"}}}\n');
  observer.fromServer('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n');
  observer.fromClient('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read"}}\n');
  observer.close();
  expect(events.map(({ outcome, name }) => ({ outcome, name }))).toEqual([
    { outcome: 'success', name: 'search' },
    { outcome: 'unknown', name: 'read' }
  ]);
  expect(JSON.stringify(events)).not.toContain('secret');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/proxy/protocol.test.ts`

Expected: FAIL because the observer does not exist.

- [ ] **Step 3: Implement line-buffered observation that never rewrites bytes**

```ts
// src/proxy/protocol.ts
import { performance } from 'node:perf_hooks';

interface Pending { id: string | number; name: string; started: number }
export class McpProtocolObserver {
  private readonly pending = new Map<string | number, Pending>();
  constructor(private readonly agent: string, private readonly server: string, private readonly connectionId: string, private readonly emit: (event: any) => void) {}
  fromClient(line: string): void { this.inspect(line, true); }
  fromServer(line: string): void { this.inspect(line, false); }
  close(): void { for (const pending of this.pending.values()) this.finish(pending, 'unknown'); this.pending.clear(); }
  private inspect(line: string, client: boolean): void {
    let value: any; try { value = JSON.parse(line); } catch { return; }
    for (const message of Array.isArray(value) ? value : [value]) {
      if (client && message.method === 'tools/call' && message.id !== undefined) this.pending.set(message.id, { id: message.id, name: message.params?.name ?? 'unknown', started: performance.now() });
      if (!client && message.id !== undefined && this.pending.has(message.id)) this.finish(this.pending.get(message.id)!, message.error ? 'failure' : 'success');
    }
  }
  private finish(pending: Pending, outcome: 'success' | 'failure' | 'unknown'): void {
    this.pending.delete(pending.id);
    this.emit({ agent: this.agent, server: this.server, connectionId: this.connectionId, requestId: pending.id, name: pending.name, outcome, durationMs: performance.now() - pending.started });
  }
}
```

- [ ] **Step 4: Implement child relay, signal forwarding, stderr passthrough, and observer side buffers**

```ts
// src/proxy/stdio-proxy.ts
import { spawn } from 'node:child_process';
import type { McpProtocolObserver } from './protocol.js';

const observeLines = (consume: (line: string) => void) => {
  let pending = '';
  return (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    for (;;) { const index = pending.indexOf('\n'); if (index < 0) break; consume(pending.slice(0, index + 1)); pending = pending.slice(index + 1); }
  };
};

export async function runStdioProxy(command: string, args: string[], observer: McpProtocolObserver, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const clientObserver = observeLines((line) => observer.fromClient(line));
  const serverObserver = observeLines((line) => observer.fromServer(line));
  process.stdin.on('data', (chunk: Buffer) => { child.stdin.write(chunk); clientObserver(chunk); });
  child.stdout.on('data', (chunk: Buffer) => { process.stdout.write(chunk); serverObserver(chunk); });
  child.stderr.pipe(process.stderr);
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => forward(signal));
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => { observer.close(); resolve(code ?? 1); });
  });
}
```

- [ ] **Step 5: Add fake-server integration coverage**

```js
// tests/fixtures/fake-mcp-server.mjs
import readline from 'node:readline';
console.error('fake-mcp-ready');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.params?.name === 'crash') process.exit(7);
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [] } })}\n`);
}
```

```ts
// tests/proxy/stdio-proxy.test.ts
it('preserves output and marks in-flight requests unknown on crash', async () => {
  const result = await runProxyFixture(['search', 'crash']);
  expect(result.stdout).toContain('"result":{"content":[]}');
  expect(result.stderr).toContain('fake-mcp-ready');
  expect(result.events.map((event) => event.outcome)).toEqual(['success', 'unknown']);
  expect(result.exitCode).toBe(7);
});
```

- [ ] **Step 6: Run proxy verification**

Run: `npm test -- tests/proxy/protocol.test.ts tests/proxy/stdio-proxy.test.ts && npm run check`

Expected: PASS, including batches and process-exit fixtures.

- [ ] **Step 7: Commit the proxy**

```bash
git add src/proxy tests/proxy tests/fixtures/fake-mcp-server.mjs
git commit -m "feat: add transparent stdio mcp proxy"
```

### Task 7: Add Adapter Contracts and CLI Routing

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/adapters/registry.ts`
- Create: `src/cli.ts`
- Create: `tests/adapters/registry.test.ts`
- Create: `tests/cli.test.ts`

- [ ] **Step 1: Write failing adapter-registry and CLI tests**

```ts
// tests/adapters/registry.test.ts
import { expect, it } from 'vitest';
import { AdapterRegistry } from '../../src/adapters/registry.js';

it('rejects duplicate adapter IDs', () => {
  const registry = new AdapterRegistry();
  const adapter = { id: 'fake' } as never;
  registry.register(adapter);
  expect(() => registry.register(adapter)).toThrow('fake');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/registry.test.ts tests/cli.test.ts`

Expected: FAIL because adapter and CLI modules do not exist.

- [ ] **Step 3: Implement capability-based adapter types**

```ts
// src/adapters/types.ts
export type Scope = 'user' | 'project';
export type Status = 'success' | 'degraded' | 'skipped' | 'failed';
export interface Capabilities { nativeSkillEvents: boolean; skillInjection: boolean; nativeMcpEvents: boolean; stdioMcpProxy: boolean; skillWatching: boolean }
export interface OperationResult { status: Status; path?: string; message: string }
export interface CoverageReport { agent: string; skills: string; mcp: string; issues: string[] }
export interface AgentAdapter {
  id: string; capabilities: Capabilities;
  discover(): Promise<string[]>;
  install(scope: Scope): Promise<OperationResult[]>;
  sync(scope: Scope): Promise<OperationResult[]>;
  repair(scope: Scope): Promise<OperationResult[]>;
  uninstall(scope: Scope): Promise<OperationResult[]>;
  health(): Promise<CoverageReport>;
}
```

```ts
// src/adapters/registry.ts
import type { AgentAdapter } from './types.js';
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  register(adapter: AgentAdapter): void { if (this.adapters.has(adapter.id)) throw new Error(`Duplicate adapter: ${adapter.id}`); this.adapters.set(adapter.id, adapter); }
  get(id: string): AgentAdapter { const adapter = this.adapters.get(id); if (!adapter) throw new Error(`Unknown adapter: ${id}`); return adapter; }
  list(): AgentAdapter[] { return [...this.adapters.values()]; }
}
```

- [ ] **Step 4: Implement CLI subcommands**

```ts
// src/cli.ts
import { Command } from 'commander';
export function createProgram(registry: AdapterRegistry): Command {
  const program = new Command().name('agent-usage');
  program.command('report [range]').option('--agent <id>').option('--kind <kind>').action(runReport);
  program.command('mcp').requiredOption('--agent <id>').action(runMcp);
  program.command('proxy').requiredOption('--agent <id>').requiredOption('--server <name>').allowUnknownOption().allowExcessArguments().action(runProxy);
  for (const command of ['install', 'sync', 'repair', 'uninstall'] as const) {
    program.command(`${command} <agent>`).option('--scope <scope>', 'user or project', 'user').option('--purge-data').option('-y, --yes').action(async (agent, options) => {
      const results = await registry.get(agent)[command](options.scope);
      if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
      if (command === 'uninstall' && options.purgeData) await purgeDataAfterConfirmation(registry, options.yes);
    });
  }
  program.command('health [agent]').action(runHealth);
  return program;
}
```

Implement named-range parsing in `runReport`: `today`, `7d`, `30d`, and `all` map to ISO lower bounds; unknown values throw a Commander validation error. `purgeDataAfterConfirmation` refuses while any adapter manifest remains and requires `--yes` when stdin is not a TTY.

- [ ] **Step 5: Verify CLI help and unknown-adapter behavior**

Run: `npm test -- tests/adapters/registry.test.ts tests/cli.test.ts && npm run check`

Expected: PASS; `agent-usage --help` snapshot lists all commands.

- [ ] **Step 6: Commit contracts and CLI**

```bash
git add src/adapters src/cli.ts tests/adapters tests/cli.test.ts
git commit -m "feat: add adapter lifecycle cli"
```

### Task 8: Bundle and Verify the Agent-Neutral Runtime

**Files:**
- Modify: `scripts/build.mjs`
- Create: `tests/integration/runtime.test.ts`

- [ ] **Step 1: Write a failing built-runtime smoke test**

```ts
// tests/integration/runtime.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('runs the bundled report command against an empty home', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-usage-runtime-'));
  const output = execFileSync(process.execPath, ['dist/agent-usage.mjs', 'report', '7d'], { env: { ...process.env, AGENT_USAGE_HOME: home }, encoding: 'utf8' });
  expect(output).toContain('Usage statistics');
});
```

- [ ] **Step 2: Run it before building to verify RED**

Run: `rm -rf dist && npm test -- tests/integration/runtime.test.ts`

Expected: FAIL because the bundle is absent.

- [ ] **Step 3: Mark Node built-ins external and preserve executable mode after build**

Update `scripts/build.mjs` to create `dist/`, bundle npm dependencies, leave `node:*` imports external, and call `chmod('dist/agent-usage.mjs', 0o755)`.

- [ ] **Step 4: Run the complete foundation verification**

Run: `npm run build && npm test && npm run check && node dist/agent-usage.mjs --help`

Expected: all tests pass, type checking exits 0, and help lists lifecycle, MCP, proxy, and report commands.

- [ ] **Step 5: Commit the verified core runtime**

```bash
git add scripts/build.mjs tests/integration/runtime.test.ts dist/agent-usage.mjs dist/agent-usage.mjs.map
git commit -m "build: bundle agent usage runtime"
```

## Core Plan Completion Check

Run:

```bash
npm run build
npm test
npm run check
AGENT_USAGE_HOME="$(mktemp -d)" node dist/agent-usage.mjs report 7d
```

Expected: clean build, all tests pass, no type errors, and an empty but valid seven-day report. Do not begin an Agent adapter until this check passes.
