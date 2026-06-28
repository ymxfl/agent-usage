import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';
import { z } from 'zod';

import { openUsageDatabase } from '../../core/database.js';
import { parseUsageEvent, type UsageEvent } from '../../core/event.js';
import { nativeDedupeKey } from '../../core/identity.js';
import { UsageRepository } from '../../core/repository.js';
import {
  emptyAgentSelection,
  loadSelectionConfig,
  selectedMcp,
  type AgentSelectionPolicy,
} from '../../core/selection.js';
import { atomicWrite } from '../../core/atomic-file.js';
import { CODEX_ADAPTER_ID } from './normalize.js';

const excludedMcpServers = new Set(['usage-stats', 'agent-usage']);

const durationSchema = z
  .object({
    secs: z.number().nonnegative().optional(),
    nanos: z.number().nonnegative().optional(),
  })
  .passthrough()
  .optional();

const sessionLogSchema = z
  .object({
    timestamp: z.string().datetime(),
    type: z.literal('event_msg'),
    payload: z
      .object({
        type: z.literal('mcp_tool_call_end'),
        call_id: z.string().min(1),
        invocation: z
          .object({
            server: z.string().min(1),
            tool: z.string().min(1),
          })
          .passthrough(),
        duration: durationSchema,
        result: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

interface SessionLogState {
  version: 1;
  files: Record<string, { digest: string }>;
}

export interface CodexSessionLogIngestorOptions {
  sessionsRoot: string;
  selectionConfigPath: string;
  databasePath: string;
  stateFile: string;
  logger: Pick<Console, 'error' | 'warn' | 'info' | 'debug' | 'log'>;
}

export interface CodexSessionLogWatchHandle {
  close(): Promise<void>;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function outcomeFromResult(result: unknown): UsageEvent['outcome'] {
  if (result && typeof result === 'object') {
    if ('Ok' in result) return 'success';
    if ('Err' in result || 'error' in result) return 'failure';
  }
  return 'unknown';
}

function durationMs(
  duration: z.infer<typeof durationSchema>,
): number | undefined {
  if (duration === undefined) return undefined;
  return (duration.secs ?? 0) * 1000 + (duration.nanos ?? 0) / 1_000_000;
}

export function normalizeCodexSessionLogLine(line: string): UsageEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  const parsed = sessionLogSchema.safeParse(raw);
  if (!parsed.success) return null;

  const { timestamp, payload } = parsed.data;
  const { server, tool } = payload.invocation;
  if (excludedMcpServers.has(server)) return null;

  const duration = durationMs(payload.duration);

  return parseUsageEvent({
    schemaVersion: 1,
    occurredAt: timestamp,
    agent: CODEX_ADAPTER_ID,
    kind: 'mcp_call',
    mcpServer: server,
    name: tool,
    outcome: outcomeFromResult(payload.result),
    ...(duration === undefined ? {} : { durationMs: duration }),
    evidence: 'session_log',
    precision: 'exact',
    dedupeKey: nativeDedupeKey(CODEX_ADAPTER_ID, payload.call_id),
  });
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files.sort();
}

async function readState(path: string): Promise<SessionLogState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SessionLogState;
    if (parsed.version === 1 && parsed.files && typeof parsed.files === 'object') {
      return parsed;
    }
  } catch {
    // Missing or malformed state is treated as a fresh scan.
  }
  return { version: 1, files: {} };
}

async function saveState(path: string, state: SessionLogState): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

export class CodexSessionLogIngestor {
  readonly #sessionsRoot: string;
  readonly #selectionConfigPath: string;
  readonly #databasePath: string;
  readonly #stateFile: string;
  readonly #logger: CodexSessionLogIngestorOptions['logger'];

  constructor(options: CodexSessionLogIngestorOptions) {
    this.#sessionsRoot = options.sessionsRoot;
    this.#selectionConfigPath = options.selectionConfigPath;
    this.#databasePath = options.databasePath;
    this.#stateFile = options.stateFile;
    this.#logger = options.logger;
  }

  async #loadPolicy(): Promise<AgentSelectionPolicy> {
    try {
      const config = await loadSelectionConfig(this.#selectionConfigPath);
      return config.agents[CODEX_ADAPTER_ID] ?? emptyAgentSelection();
    } catch {
      return emptyAgentSelection();
    }
  }

  async sync(): Promise<number> {
    const policy = await this.#loadPolicy();
    if (policy.mcp.length === 0) return 0;

    const state = await readState(this.#stateFile);
    const files = await listJsonlFiles(this.#sessionsRoot);
    let inserted = 0;
    const database = openUsageDatabase(this.#databasePath);
    const repository = new UsageRepository(database);

    try {
      for (const file of files) {
        let content: string;
        try {
          content = await readFile(file, 'utf8');
        } catch (error) {
          this.#logger.warn('Failed to read Codex session log', error);
          continue;
        }

        const digest = sha256(content);
        if (state.files[file]?.digest === digest) continue;

        for (const line of content.split('\n')) {
          if (line.trim().length === 0) continue;
          const event = normalizeCodexSessionLogLine(line);
          if (
            event === null ||
            event.mcpServer === undefined ||
            !selectedMcp(policy, event.mcpServer, event.name)
          ) {
            continue;
          }
          if (repository.insert(event)) inserted += 1;
        }
        state.files[file] = { digest };
      }
    } finally {
      database.close();
    }

    await saveState(this.#stateFile, state).catch((error) => {
      this.#logger.warn('Failed to save Codex session log state', error);
    });
    return inserted;
  }

  async watch(): Promise<CodexSessionLogWatchHandle> {
    await this.sync();
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(dirname(this.#stateFile), { recursive: true }),
    );

    const watcher: FSWatcher = chokidar.watch(this.#sessionsRoot, {
      ignoreInitial: true,
      persistent: true,
      depth: 5,
    });
    let timer: NodeJS.Timeout | undefined;
    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void this.sync().catch((error) => {
          this.#logger.error('Failed to sync Codex session logs', error);
        });
      }, 200);
    };
    watcher.on('add', schedule);
    watcher.on('change', schedule);

    return {
      close: async () => {
        if (timer !== undefined) clearTimeout(timer);
        await watcher.close();
      },
    };
  }
}
