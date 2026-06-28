import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

import * as StreamJsonParserModule from 'stream-json/core/parser.js';
import type { Token } from 'stream-json/core/parser.js';
import { getManyValues, isMany, none } from 'stream-chain/defs.js';

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

const UNKNOWN_PATH = Symbol('unknown-json-path');
type JsonPathPart = string | number | typeof UNKNOWN_PATH;

interface ObjectFrame {
  kind: 'object';
  path: JsonPathPart[];
  key: string | typeof UNKNOWN_PATH | undefined;
}

interface ArrayFrame {
  kind: 'array';
  path: JsonPathPart[];
  index: number;
}

type StructuralFrame = ObjectFrame | ArrayFrame;
type JsonObject = Record<string, unknown>;
type MetadataField = 'id' | 'method' | 'name';

interface MetadataTarget {
  messageKey: string;
  field: MetadataField;
  limit: number;
}

interface TokenCollector {
  kind: 'key' | 'string' | 'number';
  target?: MetadataTarget | undefined;
  value: string;
  bytes: number;
  limit: number;
  overflow: boolean;
}

type RawJsonParser = (value: string | typeof none) => unknown;

const SELF_SERVERS = new Set(['usage-stats', 'agent-usage']);

// Metadata is retained only up to these explicit UTF-8 byte limits. All other
// string/number token chunks (arguments and results included) are discarded.
const MAX_JSON_KEY_BYTES = 64;
const MAX_MCP_METHOD_BYTES = 64;
const MAX_MCP_TOOL_NAME_BYTES = 4096;
const MAX_JSON_RPC_STRING_ID_BYTES = 1024;
const MAX_JSON_RPC_NUMBER_ID_BYTES = 128;
const PARSER_INPUT_CHUNK_BYTES = 16 * 1024;

const createRawJsonParser = (
  StreamJsonParserModule as unknown as {
    jsonParser(options: {
      packKeys: boolean;
      packStrings: boolean;
      packNumbers: boolean;
      streamKeys: boolean;
      streamStrings: boolean;
      streamNumbers: boolean;
    }): RawJsonParser;
  }
).jsonParser;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestKey(id: string | number): string {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function isValidId(value: unknown): value is string | number {
  if (typeof value === 'string') {
    return Buffer.byteLength(value) <= MAX_JSON_RPC_STRING_ID_BYTES;
  }
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidToolName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_MCP_TOOL_NAME_BYTES;
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
      ...(isValidId(message.id) ? { id: message.id } : {}),
      ...(typeof message.method === 'string' &&
        Buffer.byteLength(message.method) <= MAX_MCP_METHOD_BYTES
        ? { method: message.method }
        : {}),
      ...(isValidToolName(params?.name) ? { name: params.name } : {}),
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

function tokensFrom(result: unknown): Token[] {
  if (result === none) return [];
  if (isMany(result)) return getManyValues(result) as Token[];
  return [result as Token];
}

class JsonRpcTokenExtractor {
  readonly #frames: StructuralFrame[] = [];
  readonly #messages = new Map<string, ObservedJsonRpcMessage>();
  #collector: TokenCollector | undefined;
  #rootStarted = false;

  accept(token: Token): void {
    switch (token.name) {
      case 'startKey':
        this.#collector = this.#newCollector('key', MAX_JSON_KEY_BYTES);
        break;
      case 'stringChunk':
      case 'numberChunk':
        this.#append(token.value);
        break;
      case 'endKey':
        this.#finishKey();
        break;
      case 'startString':
        this.#startScalar('string');
        break;
      case 'endString':
        this.#finishScalar();
        break;
      case 'startNumber':
        this.#startScalar('number');
        break;
      case 'endNumber':
        this.#finishScalar();
        break;
      case 'startObject':
        this.#startContainer('object');
        break;
      case 'endObject':
        this.#frames.pop();
        break;
      case 'startArray':
        this.#startContainer('array');
        break;
      case 'endArray':
        this.#frames.pop();
        break;
      case 'trueValue':
      case 'falseValue':
        this.#captureLiteral(token.value);
        break;
      case 'nullValue':
        this.#captureLiteral(null);
        break;
      case 'keyValue':
      case 'stringValue':
      case 'numberValue':
      case 'whitespace':
        // Packing is disabled. These cases are retained for exhaustive typing.
        break;
    }
  }

  get messages(): ObservedJsonRpcMessage[] {
    return [...this.#messages.values()];
  }

  get bufferedMetadataBytes(): number {
    let total = this.#collector?.bytes ?? 0;
    for (const message of this.#messages.values()) {
      if (typeof message.id === 'string') total += Buffer.byteLength(message.id);
      if (message.method !== undefined) total += Buffer.byteLength(message.method);
      if (message.name !== undefined) total += Buffer.byteLength(message.name);
    }
    return total;
  }

  #newCollector(
    kind: TokenCollector['kind'],
    limit: number,
    target?: MetadataTarget,
  ): TokenCollector {
    return { kind, target, value: '', bytes: 0, limit, overflow: false };
  }

  #append(value: string): void {
    const collector = this.#collector;
    if (collector === undefined || collector.overflow) return;
    const bytes = Buffer.byteLength(value);
    if (collector.bytes + bytes > collector.limit) {
      collector.value = '';
      collector.bytes = 0;
      collector.overflow = true;
      return;
    }
    collector.value += value;
    collector.bytes += bytes;
  }

  #finishKey(): void {
    const collector = this.#collector;
    this.#collector = undefined;
    const frame = this.#frames.at(-1);
    if (frame?.kind !== 'object' || collector?.kind !== 'key') return;
    frame.key = collector.overflow ? UNKNOWN_PATH : collector.value;
  }

  #startScalar(kind: 'string' | 'number'): void {
    const path = this.#consumeValuePath();
    if (path === undefined) return;
    this.#markResponsePresence(path);
    const target = this.#metadataTarget(path, kind);
    const limit = target?.limit ?? 0;
    this.#collector = this.#newCollector(kind, limit, target);
    if (target === undefined) this.#collector.overflow = true;
  }

  #finishScalar(): void {
    const collector = this.#collector;
    this.#collector = undefined;
    if (
      collector === undefined ||
      collector.kind === 'key' ||
      collector.target === undefined ||
      collector.overflow
    ) {
      return;
    }

    const message = this.#message(collector.target.messageKey);
    if (collector.target.field === 'id') {
      if (collector.kind === 'string') {
        message.id = collector.value;
      } else {
        const id = Number(collector.value);
        if (Number.isFinite(id)) message.id = id;
      }
    } else if (collector.target.field === 'method') {
      message.method = collector.value;
    } else if (collector.value.length > 0) {
      message.name = collector.value;
    }
  }

  #startContainer(kind: StructuralFrame['kind']): void {
    const path = this.#consumeValuePath();
    if (path === undefined) return;
    this.#markResponsePresence(path);
    if (kind === 'object') {
      this.#frames.push({ kind, path, key: undefined });
    } else {
      this.#frames.push({ kind, path, index: 0 });
    }
  }

  #captureLiteral(value: boolean | null): void {
    const path = this.#consumeValuePath();
    if (path === undefined) return;
    this.#markResponsePresence(path);
    const location = messagePath(path);
    if (
      value === true &&
      location?.relative.length === 2 &&
      location.relative[0] === 'result' &&
      location.relative[1] === 'isError'
    ) {
      this.#message(location.key).isError = true;
    }
  }

  #consumeValuePath(): JsonPathPart[] | undefined {
    const frame = this.#frames.at(-1);
    if (frame === undefined) {
      if (this.#rootStarted) return undefined;
      this.#rootStarted = true;
      return [];
    }
    if (frame.kind === 'array') {
      const path = [...frame.path, frame.index];
      frame.index += 1;
      return path;
    }

    const key = frame.key ?? UNKNOWN_PATH;
    frame.key = undefined;
    return [...frame.path, key];
  }

  #metadataTarget(
    path: JsonPathPart[],
    kind: 'string' | 'number',
  ): MetadataTarget | undefined {
    const location = messagePath(path);
    if (location === undefined) return undefined;
    const relative = location.relative;
    if (relative.some((part) => typeof part !== 'string')) return undefined;
    if (relative.length === 1 && relative[0] === 'id') {
      return {
        messageKey: location.key,
        field: 'id',
        limit: kind === 'string'
          ? MAX_JSON_RPC_STRING_ID_BYTES
          : MAX_JSON_RPC_NUMBER_ID_BYTES,
      };
    }
    if (kind !== 'string') return undefined;
    if (relative.length === 1 && relative[0] === 'method') {
      return {
        messageKey: location.key,
        field: 'method',
        limit: MAX_MCP_METHOD_BYTES,
      };
    }
    if (
      relative.length === 2 &&
      relative[0] === 'params' &&
      relative[1] === 'name'
    ) {
      return {
        messageKey: location.key,
        field: 'name',
        limit: MAX_MCP_TOOL_NAME_BYTES,
      };
    }
    return undefined;
  }

  #markResponsePresence(path: JsonPathPart[]): void {
    const location = messagePath(path);
    if (location === undefined || location.relative.length !== 1) return;
    const [property] = location.relative;
    if (property === 'result') this.#message(location.key).hasResult = true;
    else if (property === 'error') this.#message(location.key).hasError = true;
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
  readonly #decoder = new StringDecoder('utf8');
  readonly #extractor = new JsonRpcTokenExtractor();
  readonly #parser: RawJsonParser;
  #invalid = false;

  constructor() {
    this.#parser = createRawJsonParser({
      packKeys: false,
      packStrings: false,
      packNumbers: false,
      streamKeys: true,
      streamStrings: true,
      streamNumbers: true,
    });
  }

  write(bytes: Uint8Array): void {
    if (this.#invalid || bytes.length === 0) return;
    for (let offset = 0; offset < bytes.length; offset += PARSER_INPUT_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, offset + PARSER_INPUT_CHUNK_BYTES);
      const buffer = Buffer.isBuffer(slice)
        ? slice
        : Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
      this.#writeText(this.#decoder.write(buffer));
      if (this.#invalid) return;
    }
  }

  finish(): ObservedJsonRpcMessage[] {
    if (!this.#invalid) {
      this.#writeText(this.#decoder.end());
      try {
        this.#acceptResult(this.#parser(none));
      } catch {
        this.#invalid = true;
      }
    }
    return this.#invalid ? [] : this.#extractor.messages;
  }

  get bufferedMetadataBytes(): number {
    return this.#extractor.bufferedMetadataBytes;
  }

  #writeText(text: string): void {
    if (this.#invalid || text.length === 0) return;
    try {
      this.#acceptResult(this.#parser(text));
    } catch {
      this.#invalid = true;
    }
  }

  #acceptResult(result: unknown): void {
    for (const token of tokensFrom(result)) this.#extractor.accept(token);
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
    const bytes = typeof chunk === 'string'
      ? Buffer.from(chunk)
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
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

  get bufferedMetadataBytes(): number {
    return this.#frame.bufferedMetadataBytes;
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
  #recordSequence = 0;
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

  get bufferedMetadataBytes(): number {
    let total = this.#clientStream.bufferedMetadataBytes +
      this.#serverStream.bufferedMetadataBytes;
    for (const call of this.#inFlight.values()) {
      total += Buffer.byteLength(call.name);
      if (typeof call.id === 'string') total += Buffer.byteLength(call.id);
    }
    return total;
  }

  observeClientLine(line: string | Uint8Array): void {
    if (this.#closed || this.#disabled) return;
    const parsed = parseLine(line);
    if (parsed !== undefined) this.#observeClientMessages(observedMessages(parsed));
  }

  observeServerLine(line: string | Uint8Array): void {
    if (this.#closed || this.#disabled) return;
    const parsed = parseLine(line);
    if (parsed !== undefined) this.#observeServerMessages(observedMessages(parsed));
  }

  observeClientChunk(chunk: string | Uint8Array): void {
    if (!this.#closed && !this.#disabled) this.#clientStream.push(chunk);
  }

  observeServerChunk(chunk: string | Uint8Array): void {
    if (!this.#closed && !this.#disabled) this.#serverStream.push(chunk);
  }

  endClientStream(): void {
    if (!this.#closed && !this.#disabled) this.#clientStream.end();
  }

  endServerStream(): void {
    if (!this.#closed && !this.#disabled) this.#serverStream.end();
  }

  close(): void {
    if (this.#closed) return;
    if (!this.#disabled) {
      this.#clientStream.end();
      this.#serverStream.end();
    }
    this.#closed = true;
    for (const call of this.#inFlight.values()) this.#record(call, 'unknown');
    this.#inFlight.clear();
  }

  #observeClientMessages(streamMessages: ObservedJsonRpcMessage[]): void {
    for (const message of streamMessages) {
      if (message.method !== 'tools/call') continue;
      if (!isValidId(message.id) || !isValidToolName(message.name)) continue;
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
      if (!isValidId(message.id)) continue;
      if (!message.hasResult && !message.hasError) continue;
      const key = requestKey(message.id);
      const call = this.#inFlight.get(key);
      if (call === undefined) continue;
      this.#inFlight.delete(key);
      this.#record(call, message.hasError || message.isError ? 'failure' : 'success');
    }
  }

  #record(call: InFlightCall, outcome: UsageEvent['outcome']): void {
    this.#recordSequence += 1;
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
      dedupeKey: proxyDedupeKey(
        this.#connectionId,
        call.id,
        this.#recordSequence,
      ),
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
