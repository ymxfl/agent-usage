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

/** Frames larger than this are relayed but omitted from protocol observation. */
export const MAX_OBSERVABLE_FRAME_BYTES = 1024 * 1024;

class LineBuffer {
  #parts: Buffer[] = [];
  #size = 0;
  #skipping = false;
  #flushed = false;
  readonly #observe: (line: Uint8Array) => void;

  constructor(observe: (line: Uint8Array) => void) {
    this.#observe = observe;
  }

  push(chunk: Buffer | string): void {
    if (this.#flushed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    let offset = 0;

    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      this.#append(bytes.subarray(offset, end));

      if (newline === -1) break;
      if (!this.#skipping) this.#send(this.#joinedParts());
      this.#resetFrame();
      offset = newline + 1;
    }
  }

  flush(): void {
    if (this.#flushed) return;
    this.#flushed = true;
    if (!this.#skipping && this.#size > 0) this.#send(this.#joinedParts());
    this.#resetFrame();
  }

  #append(bytes: Buffer): void {
    if (this.#skipping || bytes.length === 0) return;
    if (this.#size + bytes.length > MAX_OBSERVABLE_FRAME_BYTES) {
      this.#parts = [];
      this.#size = 0;
      this.#skipping = true;
      return;
    }

    this.#parts.push(bytes);
    this.#size += bytes.length;
  }

  #joinedParts(): Buffer {
    if (this.#parts.length === 1) return this.#parts[0] as Buffer;
    return Buffer.concat(this.#parts, this.#size);
  }

  #resetFrame(): void {
    this.#parts = [];
    this.#size = 0;
    this.#skipping = false;
  }

  #send(line: Uint8Array): void {
    try {
      this.#observe(line);
    } catch {
      // Observation is deliberately out-of-band from the protocol relay.
    }
  }
}

interface RelayController {
  dispose(): void;
}

function relayOutput(
  source: Readable,
  destination: Writable,
  onChunk: (chunk: Buffer | string) => void,
  onComplete: () => void,
  onFailure: (error: Error) => void,
): RelayController {
  let disposed = false;
  let sourceEnded = false;
  let pendingWrites = 0;
  let waitingForDrain = false;

  const maybeComplete = () => {
    if (!disposed && sourceEnded && pendingWrites === 0) {
      dispose();
      onComplete();
    }
  };
  const onDrain = () => {
    waitingForDrain = false;
    if (!disposed) source.resume();
  };
  const onData = (chunk: Buffer | string) => {
    onChunk(chunk);
    pendingWrites += 1;
    let canContinue: boolean;
    try {
      canContinue = destination.write(chunk, (error: Error | null | undefined) => {
        pendingWrites -= 1;
        if (error === null || error === undefined) maybeComplete();
      });
    } catch (error) {
      pendingWrites -= 1;
      onFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (!canContinue) {
      waitingForDrain = true;
      source.pause();
      destination.once('drain', onDrain);
    }
  };
  const onEnd = () => {
    sourceEnded = true;
    maybeComplete();
  };
  const onSourceError = (error: Error) => onFailure(error);
  const onDestinationError = (error: Error) => onFailure(error);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    source.removeListener('data', onData);
    source.removeListener('end', onEnd);
    source.removeListener('error', onSourceError);
    destination.removeListener('error', onDestinationError);
    if (waitingForDrain) destination.removeListener('drain', onDrain);
  };

  source.on('data', onData);
  source.once('end', onEnd);
  source.once('error', onSourceError);
  destination.once('error', onDestinationError);

  return { dispose };
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

  return new Promise<StdioProxyResult>((resolve, reject) => {
    let settled = false;
    let childClosed = false;
    let stdoutFlushed = false;
    let stderrFlushed = false;
    let childResult: StdioProxyResult | undefined;
    let childError: Error | undefined;
    let relayError: Error | undefined;
    let stdoutRelay!: RelayController;
    let stderrRelay!: RelayController;
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const onInputData = (chunk: Buffer | string) => clientLines.push(chunk);
    const onInputEnd = () => clientLines.flush();
    const onInputError = (error: Error) => failRelay(error);
    const onStdinError = () => {
      // EPIPE is expected when a child exits before its client finishes writing.
    };

    const cleanup = () => {
      input.removeListener('data', onInputData);
      input.removeListener('end', onInputEnd);
      input.removeListener('error', onInputError);
      child.stdin.removeListener('error', onStdinError);
      input.unpipe(child.stdin);
      stdoutRelay.dispose();
      stderrRelay.dispose();
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };

    const settle = () => {
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

      const failure = childError ?? relayError;
      if (failure !== undefined) reject(failure);
      else resolve(childResult as StdioProxyResult);
    };

    const maybeSettle = () => {
      if (!childClosed) return;
      if (childError !== undefined || relayError !== undefined) {
        settle();
        return;
      }
      if (stdoutFlushed && stderrFlushed) settle();
    };

    function failRelay(error: Error): void {
      if (relayError !== undefined) return;
      relayError = error;
      input.unpipe(child.stdin);
      stdoutRelay.dispose();
      stderrRelay.dispose();
      if (!childClosed) child.kill();
      maybeSettle();
    }

    stdoutRelay = relayOutput(
      child.stdout,
      output,
      (chunk) => serverLines.push(chunk),
      () => {
        serverLines.flush();
        stdoutFlushed = true;
        maybeSettle();
      },
      failRelay,
    );
    stderrRelay = relayOutput(
      child.stderr,
      errorOutput,
      () => {},
      () => {
        stderrFlushed = true;
        maybeSettle();
      },
      failRelay,
    );

    for (const signal of signalNames) {
      const handler = () => {
        if (!settled) child.kill(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    input.on('data', onInputData);
    input.once('end', onInputEnd);
    input.once('error', onInputError);
    child.stdin.on('error', onStdinError);
    input.pipe(child.stdin);

    child.once('error', (error) => {
      childError = error;
    });
    child.once('close', (code, signal) => {
      childClosed = true;
      childResult = { code, signal };
      input.unpipe(child.stdin);
      maybeSettle();
    });
  });
}
