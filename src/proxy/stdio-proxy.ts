import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface StdioProtocolObserver {
  observeClientLine(line: string | Uint8Array): void;
  observeServerLine(line: string | Uint8Array): void;
  close(): void;
}

export interface StdioProxyOptions {
  cwd?: string | URL | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  input?: Readable | undefined;
  output?: Writable | undefined;
  error?: Writable | undefined;
}

export interface StdioProxyResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

class LineBuffer {
  #pending = Buffer.alloc(0);
  #flushed = false;
  readonly #observe: (line: Uint8Array) => void;

  constructor(observe: (line: Uint8Array) => void) {
    this.#observe = observe;
  }

  push(chunk: Buffer | string): void {
    if (this.#flushed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    this.#pending = this.#pending.length === 0
      ? bytes
      : Buffer.concat([this.#pending, bytes]);

    let newline = this.#pending.indexOf(0x0a);
    while (newline !== -1) {
      this.#send(this.#pending.subarray(0, newline));
      this.#pending = this.#pending.subarray(newline + 1);
      newline = this.#pending.indexOf(0x0a);
    }
  }

  flush(): void {
    if (this.#flushed) return;
    this.#flushed = true;
    if (this.#pending.length > 0) this.#send(this.#pending);
    this.#pending = Buffer.alloc(0);
  }

  #send(line: Uint8Array): void {
    try {
      this.#observe(line);
    } catch {
      // Observation is deliberately out-of-band from the protocol relay.
    }
  }
}

export function runStdioProxy(
  command: string,
  args: readonly string[],
  observer: StdioProtocolObserver,
  options: StdioProxyOptions = {},
): Promise<StdioProxyResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.error ?? process.stderr;
  const spawnOptions = {
    stdio: 'pipe' as const,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  const child = spawn(command, [...args], spawnOptions);
  const clientLines = new LineBuffer((line) => observer.observeClientLine(line));
  const serverLines = new LineBuffer((line) => observer.observeServerLine(line));
  const signalNames = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  let settled = false;

  const onInputData = (chunk: Buffer | string) => clientLines.push(chunk);
  const onInputEnd = () => clientLines.flush();
  const onServerData = (chunk: Buffer | string) => serverLines.push(chunk);
  const onServerEnd = () => serverLines.flush();
  const onStdinError = () => {
    // EPIPE is expected when a child exits before its client finishes writing.
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signalNames) {
    const handler = () => {
      if (!settled) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  input.on('data', onInputData);
  input.once('end', onInputEnd);
  child.stdout.on('data', onServerData);
  child.stdout.once('end', onServerEnd);
  child.stdin.on('error', onStdinError);

  input.pipe(child.stdin);
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(errorOutput, { end: false });

  return new Promise<StdioProxyResult>((resolve, reject) => {
    const cleanup = () => {
      input.removeListener('data', onInputData);
      input.removeListener('end', onInputEnd);
      child.stdout.removeListener('data', onServerData);
      child.stdout.removeListener('end', onServerEnd);
      child.stdin.removeListener('error', onStdinError);
      input.unpipe(child.stdin);
      child.stdout.unpipe(output);
      child.stderr.unpipe(errorOutput);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };

    const finish = (
      result: StdioProxyResult | undefined,
      spawnError: Error | undefined,
    ) => {
      if (settled) return;
      settled = true;
      clientLines.flush();
      serverLines.flush();
      cleanup();
      try {
        observer.close();
      } catch {
        // Observation cannot change child-process semantics.
      }

      if (spawnError !== undefined) reject(spawnError);
      else resolve(result as StdioProxyResult);
    };

    child.once('error', (spawnError) => finish(undefined, spawnError));
    child.once('close', (code, signal) => finish({ code, signal }, undefined));
  });
}
