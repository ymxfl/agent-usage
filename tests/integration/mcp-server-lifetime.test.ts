import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { openUsageDatabase } from '../../src/core/database.js';
import { UsageRepository } from '../../src/core/repository.js';
import { UsageMcpService } from '../../src/mcp/service.js';
import { runUsageMcpServer } from '../../src/mcp/server.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Newline-delimited JSON-RPC framing used by the stdio transport. */
function frame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

interface WireSession {
  input: PassThrough;
  /** Resolves the JSON-RPC response (parsed) for the given request id. */
  nextResponse(id: number | string): Promise<Record<string, unknown>>;
  write(message: unknown): void;
}

/** Drive an MCP stdio server over a pair of in-memory streams. */
function wireSession(output: PassThrough): WireSession {
  const input = new PassThrough();
  const lines: string[] = [];
  let pending = '';

  output.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      lines.push(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });

  return {
    input,
    write(message) {
      input.write(frame(message));
    },
    async nextResponse(id) {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        for (let index = 0; index < lines.length; index += 1) {
          const message = JSON.parse(lines[index] as string) as Record<string, unknown>;
          if (message.id === id) {
            lines.splice(index, 1);
            return message;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(
        `timed out waiting for response id=${id}; buffered=${JSON.stringify(lines)}`,
      );
    },
  };
}

describe('runUsageMcpServer session lifetime', () => {
  it('keeps the usage database open for the whole session so record_skill records', async () => {
    // Mirror the CLI `mcp` action exactly: open the DB, run the server for the
    // session, then close the DB once it returns. Previously the server
    // resolved at connect time, so this `finally` finalized the prepared
    // INSERT before record_skill ran.
    const directory = mkdtempSync(join(tmpdir(), 'mcp-lifetime-'));
    tempDirectories.push(directory);
    const databasePath = join(directory, 'usage.db');
    const database = openUsageDatabase(databasePath);

    const output = new PassThrough();
    const wire = wireSession(output);

    const closedDatabase = new Promise<boolean>((resolve) => {
      const original = database.close.bind(database);
      database.close = () => {
        resolve(true);
        return original();
      };
    });

    const serverDone = runUsageMcpServer(
      new UsageMcpService(new UsageRepository(database), 'joycode', 'connection-1'),
      undefined,
      { stdin: wire.input, stdout: output },
    ).finally(() => database.close());

    // MCP handshake.
    wire.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lifetime-test', version: '0.0.0' },
      },
    });
    const init = await wire.nextResponse(1);
    expect(init.result).toMatchObject({
      serverInfo: { name: 'usage-stats' },
    });
    wire.write({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // The failing call from the bug report.
    wire.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'record_skill',
        arguments: { skill_id: 'joycode:user:25646408fd0d78e9' },
      },
    });
    const recorded = await wire.nextResponse(2);
    expect(recorded.result).toMatchObject({
      structuredContent: { ok: true, recorded: true, next: 'continue' },
    });

    // The client disconnects; the session ends and the DB is closed *afterward*.
    wire.input.end();
    await serverDone;
    expect(await closedDatabase).toBe(true);

    // The event survived the session — reopen and count it.
    const verifyDatabase = openUsageDatabase(databasePath);
    try {
      expect(new UsageRepository(verifyDatabase).count()).toBe(1);
    } finally {
      verifyDatabase.close();
    }
  });
});
