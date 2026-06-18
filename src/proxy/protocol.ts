import { performance } from 'node:perf_hooks';

import type { UsageEvent } from '../core/event.js';
import { proxyDedupeKey } from '../core/identity.js';

export type UsageEventEmitter = (
  event: UsageEvent,
) => unknown | Promise<unknown>;

export interface McpProtocolLogger {
  error(message: string, error: unknown): void;
}

interface InFlightCall {
  readonly id: string | number;
  readonly name: string;
  readonly startedAt: number;
}

type JsonObject = Record<string, unknown>;

const SELF_SERVERS = new Set(['usage-stats', 'agent-usage']);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestKey(id: string | number): string {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function parseLine(line: string | Uint8Array): unknown | undefined {
  try {
    const text = typeof line === 'string' ? line : Buffer.from(line).toString();
    if (text.trim() === '') return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function messages(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

export class McpProtocolObserver {
  readonly #agent: string;
  readonly #server: string;
  readonly #connectionId: string;
  readonly #emit: UsageEventEmitter;
  readonly #logger: McpProtocolLogger;
  readonly #inFlight = new Map<string, InFlightCall>();
  readonly #disabled: boolean;
  #closed = false;

  constructor(
    agent: string,
    server: string,
    connectionId: string,
    emit: UsageEventEmitter,
    logger: McpProtocolLogger = console,
  ) {
    this.#agent = agent;
    this.#server = server;
    this.#connectionId = connectionId;
    this.#emit = emit;
    this.#logger = logger;
    this.#disabled = SELF_SERVERS.has(server);
  }

  observeClientLine(line: string | Uint8Array): void {
    if (this.#closed || this.#disabled) return;

    const parsed = parseLine(line);
    if (parsed === undefined) return;

    for (const message of messages(parsed)) {
      if (!isObject(message) || message.method !== 'tools/call') continue;
      if (typeof message.id !== 'string' && typeof message.id !== 'number') continue;
      if (!isObject(message.params) || typeof message.params.name !== 'string') continue;

      const call: InFlightCall = {
        id: message.id,
        name: message.params.name,
        startedAt: performance.now(),
      };
      this.#inFlight.set(requestKey(call.id), call);
    }
  }

  observeServerLine(line: string | Uint8Array): void {
    if (this.#closed || this.#disabled) return;

    const parsed = parseLine(line);
    if (parsed === undefined) return;

    for (const message of messages(parsed)) {
      if (!isObject(message)) continue;
      if (typeof message.id !== 'string' && typeof message.id !== 'number') continue;
      if (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) continue;

      const key = requestKey(message.id);
      const call = this.#inFlight.get(key);
      if (call === undefined) continue;

      this.#inFlight.delete(key);
      const failed = Object.hasOwn(message, 'error') ||
        (isObject(message.result) && message.result.isError === true);
      this.#record(call, failed ? 'failure' : 'success');
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    for (const call of this.#inFlight.values()) {
      this.#record(call, 'unknown');
    }
    this.#inFlight.clear();
  }

  #record(call: InFlightCall, outcome: UsageEvent['outcome']): void {
    const event: UsageEvent = {
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      agent: this.#agent,
      sessionId: this.#connectionId,
      kind: 'mcp_call',
      name: call.name,
      mcpServer: this.#server,
      outcome,
      durationMs: Math.max(0, performance.now() - call.startedAt),
      evidence: 'mcp_proxy',
      precision: 'exact',
      dedupeKey: proxyDedupeKey(this.#connectionId, call.id),
    };

    try {
      const result = this.#emit(event);
      if (result !== null && typeof result === 'object' && 'then' in result) {
        void Promise.resolve(result).catch((error: unknown) => this.#log(error));
      }
    } catch (error) {
      this.#log(error);
    }
  }

  #log(error: unknown): void {
    try {
      this.#logger.error('Failed to record proxied MCP call', error);
    } catch {
      // Diagnostics must never interfere with the proxied protocol stream.
    }
  }
}
