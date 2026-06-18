import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { UsageEvent } from '../../src/core/event.js';
import { McpProtocolObserver } from '../../src/proxy/protocol.js';
import { runStdioProxy } from '../../src/proxy/stdio-proxy.js';

const fakeServer = fileURLToPath(
  new URL('../fixtures/fake-mcp-server.mjs', import.meta.url),
);
const LARGE_FRAME_BYTES = (1024 * 1024) + 1;

function capture(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return new Promise((resolve) => stream.on('end', () => resolve(Buffer.concat(chunks))));
}

function proxyFixture(
  mode: string,
  observer: McpProtocolObserver | CountingObserver = new CountingObserver(),
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const outputDone = capture(output);
  const errorDone = capture(error);
  const completion = runStdioProxy(process.execPath, [fakeServer, mode], observer, {
    ...options,
    input,
    output,
    error,
  }).finally(() => {
    output.end();
    error.end();
  });

  return { input, error, outputDone, errorDone, completion, observer };
}

class CountingObserver {
  clientLines: string[] = [];
  serverLines: string[] = [];
  closeCount = 0;
  #clientPending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #serverPending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  observeClientLine(line: string | Uint8Array): void {
    this.clientLines.push(Buffer.from(line).toString());
  }

  observeServerLine(line: string | Uint8Array): void {
    this.serverLines.push(Buffer.from(line).toString());
  }

  observeClientChunk(chunk: string | Uint8Array): void {
    this.#clientPending = this.#consume(
      this.#clientPending,
      chunk,
      this.clientLines,
    );
  }

  observeServerChunk(chunk: string | Uint8Array): void {
    this.#serverPending = this.#consume(
      this.#serverPending,
      chunk,
      this.serverLines,
    );
  }

  endClientStream(): void {
    if (this.#clientPending.length > 0) {
      this.clientLines.push(this.#clientPending.toString());
      this.#clientPending = Buffer.alloc(0);
    }
  }

  endServerStream(): void {
    if (this.#serverPending.length > 0) {
      this.serverLines.push(this.#serverPending.toString());
      this.#serverPending = Buffer.alloc(0);
    }
  }

  close(): void {
    this.closeCount += 1;
  }

  #consume(
    pending: Buffer,
    chunk: string | Uint8Array,
    lines: string[],
  ): Buffer {
    let bytes = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline = bytes.indexOf(0x0a);
    while (newline !== -1) {
      lines.push(bytes.subarray(0, newline).toString());
      bytes = bytes.subarray(newline + 1);
      newline = bytes.indexOf(0x0a);
    }
    return bytes;
  }
}

class GatedWritable extends Writable {
  readonly chunks: Buffer[] = [];
  readonly firstWrite: Promise<void>;
  #notifyFirstWrite!: () => void;
  #releaseFirstWrite: (() => void) | undefined;

  constructor() {
    super({ highWaterMark: 1 });
    this.firstWrite = new Promise((resolve) => {
      this.#notifyFirstWrite = resolve;
    });
  }

  release(): void {
    this.#releaseFirstWrite?.();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    if (this.#releaseFirstWrite === undefined) {
      this.#releaseFirstWrite = callback;
      this.#notifyFirstWrite();
      return;
    }
    callback();
  }
}

class FailingWritable extends Writable {
  readonly failure: Error;

  constructor(message: string) {
    super();
    this.failure = new Error(message);
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(this.failure);
  }
}

function signalListenerCounts(): number[] {
  return (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(
    (signal) => process.listenerCount(signal),
  );
}

describe('runStdioProxy', () => {
  it('relays stdin and stdout byte-for-byte and relays stderr', async () => {
    const fixture = proxyFixture('echo');
    const bytes = Buffer.from(' first line \r\nsecond line\nfinal partial', 'utf8');

    fixture.input.end(bytes);

    await expect(fixture.completion).resolves.toEqual({ code: 0, signal: null });
    await expect(fixture.outputDone).resolves.toEqual(bytes);
    await expect(fixture.errorDone).resolves.toEqual(Buffer.from('fake MCP diagnostic\n'));
    expect((fixture.observer as CountingObserver).clientLines).toEqual([
      ' first line \r',
      'second line',
      'final partial',
    ]);
    expect((fixture.observer as CountingObserver).serverLines).toEqual([
      ' first line \r',
      'second line',
      'final partial',
    ]);
    expect((fixture.observer as CountingObserver).closeCount).toBe(1);
  });

  it('honors slow-output backpressure before completing without losing bytes', async () => {
    const input = new PassThrough();
    const output = new GatedWritable();
    const error = new PassThrough();
    let completed = false;
    const completion = runStdioProxy(
      process.execPath,
      [fakeServer, 'burst'],
      new CountingObserver(),
      { input, output, error },
    ).then((result) => {
      completed = true;
      return result;
    });
    input.end();

    await output.firstWrite;
    await new Promise((resolve) => setImmediate(resolve));
    const completedWhileBlocked = completed;
    const neededDrainWhileBlocked = output.writableNeedDrain;
    const writesWhileBlocked = output.chunks.length;

    output.release();
    await expect(completion).resolves.toEqual({ code: 0, signal: null });
    expect(completedWhileBlocked).toBe(false);
    expect(neededDrainWhileBlocked).toBe(true);
    expect(writesWhileBlocked).toBe(1);
    expect(Buffer.concat(output.chunks)).toEqual(Buffer.alloc(512 * 1024, 0x78));
    error.destroy();
  });

  it('waits for final stdout and stderr writes to flush after the child exits', async () => {
    const input = new PassThrough();
    const output = new GatedWritable();
    const error = new GatedWritable();
    let completed = false;
    const completion = runStdioProxy(
      process.execPath,
      [fakeServer, 'single'],
      new CountingObserver(),
      { input, output, error },
    ).then((result) => {
      completed = true;
      return result;
    });
    input.end();

    await Promise.all([output.firstWrite, error.firstWrite]);
    const completionWhileWritesBlocked = await Promise.race([
      completion.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    output.release();
    error.release();

    await expect(completion).resolves.toEqual({ code: 0, signal: null });
    expect(completionWhileWritesBlocked).toBe(false);
    expect(completed).toBe(true);
    expect(Buffer.concat(output.chunks).toString()).toBe('single final chunk');
    expect(Buffer.concat(error.chunks).toString()).toBe('fake MCP diagnostic\n');
  });

  it('rejects input stream failures, terminates the child, and cleans up once', async () => {
    const listenersBefore = signalListenerCounts();
    const observer = new CountingObserver();
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const failure = new Error('input failed');
    const completion = runStdioProxy(
      process.execPath,
      [fakeServer, 'single'],
      observer,
      { input, output, error },
    );

    input.destroy(failure);

    await expect(completion).rejects.toBe(failure);
    expect(observer.closeCount).toBe(1);
    expect(signalListenerCounts()).toEqual(listenersBefore);
    output.destroy();
    error.destroy();
  });

  it('rejects stdout destination failures without an uncaught stream error', async () => {
    const listenersBefore = signalListenerCounts();
    const observer = new CountingObserver();
    const input = new PassThrough();
    const output = new FailingWritable('stdout destination failed');
    const error = new PassThrough();
    const completion = runStdioProxy(
      process.execPath,
      [fakeServer, 'single'],
      observer,
      { input, output, error },
    );
    input.end();

    await expect(completion).rejects.toBe(output.failure);
    expect(observer.closeCount).toBe(1);
    expect(signalListenerCounts()).toEqual(listenersBefore);
    error.destroy();
  });

  it('rejects stderr destination failures without an uncaught stream error', async () => {
    const listenersBefore = signalListenerCounts();
    const observer = new CountingObserver();
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new FailingWritable('stderr destination failed');
    const completion = runStdioProxy(
      process.execPath,
      [fakeServer, 'single'],
      observer,
      { input, output, error },
    );
    input.end();

    await expect(completion).rejects.toBe(error.failure);
    expect(observer.closeCount).toBe(1);
    expect(signalListenerCounts()).toEqual(listenersBefore);
    output.destroy();
  });

  it('fails open on oversized malformed frames while relaying every byte unchanged', async () => {
    const events: UsageEvent[] = [];
    const observer = new McpProtocolObserver(
      'codex',
      'fake',
      'large-malformed-connection',
      (event) => events.push(event),
    );
    const fixture = proxyFixture('echo', observer);
    const oversized = Buffer.alloc(LARGE_FRAME_BYTES, 0x78);
    const suffix = Buffer.from('\nsmall\n');
    const expected = Buffer.concat([oversized, suffix]);

    for (let offset = 0; offset < oversized.length; offset += 32 * 1024) {
      fixture.input.write(oversized.subarray(offset, offset + (32 * 1024)));
    }
    fixture.input.end(suffix);

    await expect(fixture.completion).resolves.toEqual({ code: 0, signal: null });
    await expect(fixture.outputDone).resolves.toEqual(expected);
    expect(events).toEqual([]);
  });

  it('records exact calls when oversized arguments precede or follow metadata', async () => {
    const events: UsageEvent[] = [];
    const observer = new McpProtocolObserver(
      'codex',
      'fake',
      'large-request-connection',
      (event) => events.push(event),
    );
    const fixture = proxyFixture('protocol', observer);
    const secretBefore = `before-secret-${'b'.repeat(LARGE_FRAME_BYTES)}`;
    const secretAfter = `after-secret-${'a'.repeat(LARGE_FRAME_BYTES)}`;
    const beforeMetadata =
      `{"params":{"arguments":{"secret":${JSON.stringify(secretBefore)}},"name":"huge_before"},` +
      '"method":"tools/call","id":101,"jsonrpc":"2.0"}\n';
    const afterMetadata =
      '{"jsonrpc":"2.0","id":102,"method":"tools/call","params":{"name":"huge_after",' +
      `"arguments":{"secret":${JSON.stringify(secretAfter)}}}}\n`;

    fixture.input.write(beforeMetadata);
    fixture.input.end(afterMetadata);

    await expect(fixture.completion).resolves.toEqual({ code: 0, signal: null });
    expect(events.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
      { name: 'huge_before', outcome: 'success' },
      { name: 'huge_after', outcome: 'success' },
    ]);
    expect(JSON.stringify(events)).not.toContain('before-secret');
    expect(JSON.stringify(events)).not.toContain('after-secret');
    expect(JSON.stringify(observer)).not.toContain('before-secret');
    expect(JSON.stringify(observer)).not.toContain('after-secret');
  });

  it('matches an oversized valid response without retaining its result payload', async () => {
    const events: UsageEvent[] = [];
    const observer = new McpProtocolObserver(
      'codex',
      'fake',
      'large-response-connection',
      (event) => events.push(event),
    );
    const fixture = proxyFixture('protocol', observer);
    fixture.input.end(
      '{"jsonrpc":"2.0","id":301,"method":"tools/call","params":{"name":"huge_response"}}\n',
    );

    await expect(fixture.completion).resolves.toEqual({ code: 0, signal: null });
    const responseBytes = await fixture.outputDone;

    expect(responseBytes.length).toBeGreaterThan(LARGE_FRAME_BYTES);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'huge_response',
      outcome: 'success',
      precision: 'exact',
    });
    expect(JSON.stringify(events)).not.toContain('response-secret');
    expect(JSON.stringify(observer)).not.toContain('response-secret');
  });

  it('records every entry in an oversized batch without retaining arguments', async () => {
    const events: UsageEvent[] = [];
    const observer = new McpProtocolObserver(
      'codex',
      'fake',
      'large-batch-connection',
      (event) => events.push(event),
    );
    const fixture = proxyFixture('protocol', observer);
    const secret = `batch-secret-${'s'.repeat(LARGE_FRAME_BYTES)}`;
    const batch =
      `[{"params":{"arguments":{"secret":${JSON.stringify(secret)}},"name":"batch_one"},` +
      '"method":"tools/call","id":201,"jsonrpc":"2.0"},' +
      '{"jsonrpc":"2.0","id":"202","method":"tools/call","params":{"name":"batch_two"}}]\n';

    fixture.input.end(batch);

    await expect(fixture.completion).resolves.toEqual({ code: 0, signal: null });
    expect(events.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
      { name: 'batch_one', outcome: 'success' },
      { name: 'batch_two', outcome: 'success' },
    ]);
    expect(JSON.stringify(events)).not.toContain('batch-secret');
    expect(JSON.stringify(observer)).not.toContain('batch-secret');
  });

  it('observes success, error, batches, odd whitespace, and a final partial frame', async () => {
    const events: UsageEvent[] = [];
    const observer = new McpProtocolObserver(
      'codex',
      'fake',
      'stdio-1',
      (event) => events.push(event),
    );
    const fixture = proxyFixture('protocol', observer);
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'success' } },
      { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'error' } },
    ];
    fixture.input.write(`${JSON.stringify(batch)}\n`);
    fixture.input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"odd"}}\n');
    fixture.input.end('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"partial"}}');

    await expect(fixture.completion).resolves.toEqual({ code: 0, signal: null });
    const stdout = (await fixture.outputDone).toString();

    expect(stdout).toContain(' \t{"jsonrpc":"2.0","id":3');
    expect(stdout.endsWith('}}')).toBe(true);
    expect(events.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
      { name: 'success', outcome: 'success' },
      { name: 'error', outcome: 'failure' },
      { name: 'odd', outcome: 'success' },
      { name: 'partial', outcome: 'success' },
    ]);
  });

  it('passes cwd and environment to the child', async () => {
    const cwd = fileURLToPath(new URL('../fixtures', import.meta.url));
    const fixture = proxyFixture('protocol', new CountingObserver(), {
      cwd,
      env: { ...process.env, FAKE_PROXY_ENV: 'visible' },
    });
    fixture.input.end('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"context"}}\n');

    await fixture.completion;
    const response = JSON.parse((await fixture.outputDone).toString());
    expect(response.result).toEqual({ cwd, env: 'visible' });
  });

  it('records one unknown call when the real MCP server crashes before answering', async () => {
    const events: UsageEvent[] = [];
    const observer = new McpProtocolObserver(
      'codex',
      'fake',
      'crash-connection',
      (event) => events.push(event),
    );
    const fixture = proxyFixture('protocol', observer);
    fixture.input.end('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"crash"}}\n');

    await expect(fixture.completion).resolves.toEqual({ code: 7, signal: null });
    expect((await fixture.errorDone).toString()).toContain('fake MCP crash');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'mcp_call',
      name: 'crash',
      outcome: 'unknown',
      mcpServer: 'fake',
    });
  });

  it('relays a JSON-RPC notification byte-for-byte without recording usage', async () => {
    const events: UsageEvent[] = [];
    const observer = new McpProtocolObserver(
      'codex',
      'fake',
      'notification-connection',
      (event) => events.push(event),
    );
    const fixture = proxyFixture('protocol', observer);
    const notification = Buffer.from(
      ' { "jsonrpc": "2.0", "method": "notifications/progress", "params": { "token": 7 } } \r\n',
    );

    fixture.input.end(notification);

    await expect(fixture.completion).resolves.toEqual({ code: 0, signal: null });
    await expect(fixture.outputDone).resolves.toEqual(notification);
    expect(events).toEqual([]);
  });

  it('forwards termination signals and reports the child signal', async () => {
    const priorListeners = process.listeners('SIGHUP');
    const fixture = proxyFixture('protocol');
    await new Promise<void>((resolve) => {
      fixture.error.once('data', () => resolve());
    });
    const proxyListener = process.listeners('SIGHUP').find(
      (listener) => !priorListeners.includes(listener),
    );

    expect(proxyListener).toBeDefined();
    proxyListener?.('SIGHUP');

    await expect(fixture.completion).resolves.toEqual({ code: null, signal: 'SIGHUP' });
    fixture.input.destroy();
  });

  it('rejects a spawn failure and closes the observer once', async () => {
    const observer = new CountingObserver();
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();

    await expect(runStdioProxy(
      '/definitely/not/a/real/executable',
      [],
      observer,
      { input, output, error },
    )).rejects.toMatchObject({ code: 'ENOENT' });
    expect(observer.closeCount).toBe(1);
    input.destroy();
    output.destroy();
    error.destroy();
  });

  it('keeps relaying when event storage fails', async () => {
    const errors: unknown[] = [];
    const observer = new McpProtocolObserver(
      'codex',
      'fake',
      'stdio-1',
      () => { throw new Error('storage unavailable'); },
      { error: (_message, error) => errors.push(error) },
    );
    const fixture = proxyFixture('protocol', observer);
    fixture.input.end('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"success"}}\n');

    await expect(fixture.completion).resolves.toEqual({ code: 0, signal: null });
    expect((await fixture.outputDone).toString()).toContain('"result"');
    expect(errors).toHaveLength(1);
  });

  it('removes process signal listeners after completion', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map((signal) => process.listenerCount(signal));
    const fixture = proxyFixture('protocol');
    fixture.input.end();

    await fixture.completion;

    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});
