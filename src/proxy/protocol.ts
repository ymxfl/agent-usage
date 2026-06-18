import { performance } from 'node:perf_hooks';

import {
  JSONParser,
  TokenType,
  type ParsedElementInfo,
  type ParsedTokenInfo,
} from '@streamparser/json';

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

interface ObservedJsonRpcMessage {
  id?: string | number | undefined;
  method?: string | undefined;
  name?: string | undefined;
  hasResult: boolean;
  hasError: boolean;
  isError: boolean;
}

type JsonPathPart = string | number;

interface ObjectFrame {
  kind: 'object';
  path: JsonPathPart[];
  state: 'key' | 'colon' | 'value' | 'comma';
  key?: string | undefined;
}

interface ArrayFrame {
  kind: 'array';
  path: JsonPathPart[];
  state: 'value' | 'comma';
  index: number;
}

type StructuralFrame = ObjectFrame | ArrayFrame;

type JsonObject = Record<string, unknown>;

const SELF_SERVERS = new Set(['usage-stats', 'agent-usage']);
const STREAM_PATHS = [
  '$.id',
  '$.method',
  '$.params.name',
  '$.result.isError',
  '$.error.code',
  '$.*.id',
  '$.*.method',
  '$.*.params.name',
  '$.*.result.isError',
  '$.*.error.code',
];

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

function observedMessages(value: unknown): ObservedJsonRpcMessage[] {
  return messages(value).flatMap((message) => {
    if (!isObject(message)) return [];
    const params = isObject(message.params) ? message.params : undefined;
    const result = isObject(message.result) ? message.result : undefined;
    return [{
      ...(typeof message.id === 'string' || typeof message.id === 'number'
        ? { id: message.id }
        : {}),
      ...(typeof message.method === 'string' ? { method: message.method } : {}),
      ...(typeof params?.name === 'string' ? { name: params.name } : {}),
      hasResult: Object.hasOwn(message, 'result'),
      hasError: Object.hasOwn(message, 'error'),
      isError: result?.isError === true,
    }];
  });
}

function messagePath(
  path: JsonPathPart[],
): { key: string; relative: JsonPathPart[] } | undefined {
  const [first, ...rest] = path;
  if (typeof first === 'number') {
    return { key: `batch:${first}`, relative: rest };
  }
  if (typeof first === 'string') {
    return { key: 'root', relative: path };
  }
  return undefined;
}

class JsonStructureTracker {
  readonly #frames: StructuralFrame[] = [];
  readonly #messages: Map<string, ObservedJsonRpcMessage>;
  #rootStarted = false;

  constructor(messages: Map<string, ObservedJsonRpcMessage>) {
    this.#messages = messages;
  }

  accept({ token, value, partial }: ParsedTokenInfo.ParsedTokenInfo): void {
    if (partial) return;
    const frame = this.#frames.at(-1);
    if (token === TokenType.SEPARATOR) return;

    if (frame?.kind === 'object' && frame.state === 'key') {
      if (token === TokenType.STRING) {
        frame.key = value as string;
        frame.state = 'colon';
        return;
      }
      if (token === TokenType.RIGHT_BRACE) {
        this.#frames.pop();
        return;
      }
    }

    if (frame?.kind === 'object' && frame.state === 'colon') {
      if (token === TokenType.COLON) frame.state = 'value';
      return;
    }

    if (
      frame?.kind === 'array' &&
      frame.state === 'value' &&
      token === TokenType.RIGHT_BRACKET
    ) {
      this.#frames.pop();
      return;
    }

    if (frame?.state === 'comma') {
      if (token === TokenType.COMMA) {
        frame.state = frame.kind === 'object' ? 'key' : 'value';
        return;
      }
      if (
        (frame.kind === 'object' && token === TokenType.RIGHT_BRACE) ||
        (frame.kind === 'array' && token === TokenType.RIGHT_BRACKET)
      ) {
        this.#frames.pop();
        return;
      }
    }

    const path = this.#consumeValuePath();
    if (path === undefined) return;
    this.#markResponsePresence(path);

    if (token === TokenType.LEFT_BRACE) {
      this.#frames.push({ kind: 'object', path, state: 'key' });
    } else if (token === TokenType.LEFT_BRACKET) {
      this.#frames.push({ kind: 'array', path, state: 'value', index: 0 });
    }
  }

  #consumeValuePath(): JsonPathPart[] | undefined {
    const frame = this.#frames.at(-1);
    if (frame === undefined) {
      if (this.#rootStarted) return undefined;
      this.#rootStarted = true;
      return [];
    }
    if (frame.state !== 'value') return undefined;

    frame.state = 'comma';
    if (frame.kind === 'object') {
      if (frame.key === undefined) return undefined;
      const path = [...frame.path, frame.key];
      frame.key = undefined;
      return path;
    }

    const path = [...frame.path, frame.index];
    frame.index += 1;
    return path;
  }

  #markResponsePresence(path: JsonPathPart[]): void {
    const location = messagePath(path);
    if (location === undefined || location.relative.length !== 1) return;
    const [property] = location.relative;
    if (property !== 'result' && property !== 'error') return;

    const message = this.#message(location.key);
    if (property === 'result') message.hasResult = true;
    else message.hasError = true;
  }

  #message(key: string): ObservedJsonRpcMessage {
    let message = this.#messages.get(key);
    if (message === undefined) {
      message = { hasResult: false, hasError: false, isError: false };
      this.#messages.set(key, message);
    }
    return message;
  }
}

class JsonRpcFrameExtractor {
  readonly #messages = new Map<string, ObservedJsonRpcMessage>();
  readonly #parser: JSONParser;
  readonly #structure: JsonStructureTracker;
  #invalid = false;

  constructor() {
    this.#structure = new JsonStructureTracker(this.#messages);
    this.#parser = new JSONParser({
      paths: STREAM_PATHS,
      keepStack: false,
      stringBufferSize: 64 * 1024,
      numberBufferSize: 64,
    });
    this.#parser.onToken = (token) => this.#structure.accept(token);
    this.#parser.onValue = (value) => this.#capture(value);
    this.#parser.onError = () => {
      this.#invalid = true;
    };
  }

  write(bytes: Uint8Array): void {
    if (this.#invalid || bytes.length === 0) return;
    try {
      this.#parser.write(bytes);
    } catch {
      this.#invalid = true;
    }
  }

  finish(): ObservedJsonRpcMessage[] {
    if (!this.#invalid && !this.#parser.isEnded) {
      try {
        this.#parser.end();
      } catch {
        this.#invalid = true;
      }
    }
    return this.#invalid ? [] : [...this.#messages.values()];
  }

  #capture({ value, key, stack }: ParsedElementInfo.ParsedElementInfo): void {
    const path = [
      ...stack.slice(1).flatMap((item) => item.key === undefined ? [] : [item.key]),
      ...(key === undefined ? [] : [key]),
    ];
    const location = messagePath(path);
    if (location === undefined) return;
    const relative = location.relative.join('.');
    if (!['id', 'method', 'params.name', 'result.isError', 'error.code'].includes(relative)) {
      return;
    }

    let message = this.#messages.get(location.key);
    if (message === undefined) {
      message = { hasResult: false, hasError: false, isError: false };
      this.#messages.set(location.key, message);
    }
    if (relative === 'id' && (typeof value === 'string' || typeof value === 'number')) {
      message.id = value;
    } else if (relative === 'method' && typeof value === 'string') {
      message.method = value;
    } else if (relative === 'params.name' && typeof value === 'string') {
      message.name = value;
    } else if (relative === 'result.isError' && value === true) {
      message.isError = true;
    } else if (relative === 'error.code') {
      message.hasError = true;
    }
  }
}

class JsonRpcMessageStream {
  readonly #observe: (messages: ObservedJsonRpcMessage[]) => void;
  #frame = new JsonRpcFrameExtractor();
  #ended = false;

  constructor(observe: (messages: ObservedJsonRpcMessage[]) => void) {
    this.#observe = observe;
  }

  push(chunk: string | Uint8Array): void {
    if (this.#ended) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    let offset = 0;
    let newline = bytes.indexOf(0x0a, offset);
    while (newline !== -1) {
      this.#frame.write(bytes.subarray(offset, newline));
      this.#finishFrame();
      offset = newline + 1;
      newline = bytes.indexOf(0x0a, offset);
    }
    this.#frame.write(bytes.subarray(offset));
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#finishFrame();
  }

  #finishFrame(): void {
    const extracted = this.#frame.finish();
    if (extracted.length > 0) this.#observe(extracted);
    this.#frame = new JsonRpcFrameExtractor();
  }
}

export class McpProtocolObserver {
  readonly #agent: string;
  readonly #server: string;
  readonly #connectionId: string;
  readonly #emit: UsageEventEmitter;
  readonly #logger: McpProtocolLogger;
  readonly #inFlight = new Map<string, InFlightCall>();
  readonly #disabled: boolean;
  readonly #clientStream: JsonRpcMessageStream;
  readonly #serverStream: JsonRpcMessageStream;
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
    this.#clientStream = new JsonRpcMessageStream(
      (streamMessages) => this.#observeClientMessages(streamMessages),
    );
    this.#serverStream = new JsonRpcMessageStream(
      (streamMessages) => this.#observeServerMessages(streamMessages),
    );
  }

  observeClientLine(line: string | Uint8Array): void {
    if (this.#closed || this.#disabled) return;

    const parsed = parseLine(line);
    if (parsed === undefined) return;

    this.#observeClientMessages(observedMessages(parsed));
  }

  observeServerLine(line: string | Uint8Array): void {
    if (this.#closed || this.#disabled) return;

    const parsed = parseLine(line);
    if (parsed === undefined) return;

    this.#observeServerMessages(observedMessages(parsed));
  }

  observeClientChunk(chunk: string | Uint8Array): void {
    if (this.#closed || this.#disabled) return;
    this.#clientStream.push(chunk);
  }

  observeServerChunk(chunk: string | Uint8Array): void {
    if (this.#closed || this.#disabled) return;
    this.#serverStream.push(chunk);
  }

  endClientStream(): void {
    if (this.#closed || this.#disabled) return;
    this.#clientStream.end();
  }

  endServerStream(): void {
    if (this.#closed || this.#disabled) return;
    this.#serverStream.end();
  }

  close(): void {
    if (this.#closed) return;
    if (!this.#disabled) {
      this.#clientStream.end();
      this.#serverStream.end();
    }
    this.#closed = true;

    for (const call of this.#inFlight.values()) {
      this.#record(call, 'unknown');
    }
    this.#inFlight.clear();
  }

  #observeClientMessages(streamMessages: ObservedJsonRpcMessage[]): void {
    for (const message of streamMessages) {
      if (message.method !== 'tools/call') continue;
      if (typeof message.id !== 'string' && typeof message.id !== 'number') continue;
      if (typeof message.name !== 'string') continue;

      const call: InFlightCall = {
        id: message.id,
        name: message.name,
        startedAt: performance.now(),
      };
      this.#inFlight.set(requestKey(call.id), call);
    }
  }

  #observeServerMessages(streamMessages: ObservedJsonRpcMessage[]): void {
    for (const message of streamMessages) {
      if (typeof message.id !== 'string' && typeof message.id !== 'number') continue;
      if (!message.hasResult && !message.hasError) continue;

      const key = requestKey(message.id);
      const call = this.#inFlight.get(key);
      if (call === undefined) continue;

      this.#inFlight.delete(key);
      this.#record(call, message.hasError || message.isError ? 'failure' : 'success');
    }
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
