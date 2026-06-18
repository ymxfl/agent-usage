import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface StdioProtocolObserver {
  observeClientChunk(chunk: string | Uint8Array): void;
  observeServerChunk(chunk: string | Uint8Array): void;
  endClientStream(): void;
  endServerStream(): void;
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
  const clientLines = {
    push: (chunk: Buffer | string) => observer.observeClientChunk(chunk),
    flush: () => observer.endClientStream(),
  };
  const serverLines = {
    push: (chunk: Buffer | string) => observer.observeServerChunk(chunk),
    flush: () => observer.endServerStream(),
  };
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
