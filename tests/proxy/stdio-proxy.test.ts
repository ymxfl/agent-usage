import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { UsageEvent } from '../../src/core/event.js';
import { McpProtocolObserver } from '../../src/proxy/protocol.js';
import { runStdioProxy } from '../../src/proxy/stdio-proxy.js';

const fakeServer = fileURLToPath(
  new URL('../fixtures/fake-mcp-server.mjs', import.meta.url),
);

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

  observeClientLine(line: string | Uint8Array): void {
    this.clientLines.push(Buffer.from(line).toString());
  }

  observeServerLine(line: string | Uint8Array): void {
    this.serverLines.push(Buffer.from(line).toString());
  }

  close(): void {
    this.closeCount += 1;
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
