import { mkdir, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexSessionLogIngestor,
  normalizeCodexSessionLogLine,
} from '../../../src/adapters/codex/session-log.js';
import { openUsageDatabase } from '../../../src/core/database.js';
import { saveSelectionConfig } from '../../../src/core/selection.js';
import { UsageRepository } from '../../../src/core/repository.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-usage-codex-log-'));
  tempDirectories.push(root);
  return root;
}

function mcpEndLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-06-28T15:00:04.213Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'call_dom_pointer_1',
      invocation: {
        server: 'dom-pointer',
        tool: 'get-pointed-element',
        arguments: {},
      },
      duration: { secs: 0, nanos: 3_899_375 },
      result: { Ok: { content: [] } },
    },
    ...overrides,
  });
}

describe('normalizeCodexSessionLogLine', () => {
  it('normalizes Codex session MCP completion events', () => {
    expect(normalizeCodexSessionLogLine(mcpEndLine())).toEqual({
      schemaVersion: 1,
      occurredAt: '2026-06-28T15:00:04.213Z',
      agent: 'codex',
      kind: 'mcp_call',
      mcpServer: 'dom-pointer',
      name: 'get-pointed-element',
      outcome: 'success',
      durationMs: 3.899375,
      evidence: 'session_log',
      precision: 'exact',
      dedupeKey: 'codex:native:call_dom_pointer_1',
    });
  });

  it('ignores accounting server events and unrelated lines', () => {
    expect(normalizeCodexSessionLogLine('not json')).toBeNull();
    expect(
      normalizeCodexSessionLogLine(
        mcpEndLine({
          payload: {
            type: 'mcp_tool_call_end',
            call_id: 'call_usage_stats_1',
            invocation: { server: 'usage-stats', tool: 'record-skill' },
            result: { Ok: {} },
          },
        }),
      ),
    ).toBeNull();
  });
});

describe('CodexSessionLogIngestor', () => {
  it('inserts selected MCP calls from Codex session logs once', async () => {
    const root = makeRoot();
    const sessionsRoot = join(root, '.codex', 'sessions');
    const day = join(sessionsRoot, '2026', '06', '28');
    await mkdir(day, { recursive: true });
    await mkdir(join(root, '.agent-usage'), { recursive: true });
    const logPath = join(day, 'rollout.jsonl');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(logPath, `${mcpEndLine()}\n`),
    );
    const selectionConfigPath = join(root, '.agent-usage', 'config.json');
    await saveSelectionConfig(selectionConfigPath, {
      version: 1,
      agents: {
        codex: {
          skills: { native_hook: [], injected_mcp: [] },
          mcp: ['dom-pointer'],
        },
      },
    });
    const databasePath = join(root, '.agent-usage', 'usage.db');
    const stateFile = join(root, '.agent-usage', 'state', 'codex-session-log-state.json');
    const ingestor = new CodexSessionLogIngestor({
      sessionsRoot,
      selectionConfigPath,
      databasePath,
      stateFile,
      logger: { error() {}, warn() {}, info() {}, debug() {}, log() {} },
    });

    await ingestor.sync();
    await ingestor.sync();

    const database = openUsageDatabase(databasePath);
    try {
      const repository = new UsageRepository(database as DatabaseSync);
      const report = repository.report({ agent: 'codex', kind: 'mcp_call' }, 'all');
      expect(report.totals).toEqual([
        {
          agent: 'codex',
          kind: 'mcp_call',
          evidence: 'session_log',
          precision: 'exact',
          count: 1,
        },
      ]);
      await expect(readFile(stateFile, 'utf8')).resolves.toContain('rollout.jsonl');
    } finally {
      database.close();
    }
  });
});
