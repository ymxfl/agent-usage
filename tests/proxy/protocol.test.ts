import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UsageEvent } from '../../src/core/event.js';
import { McpProtocolObserver } from '../../src/proxy/protocol.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(server = 'filesystem') {
  const events: UsageEvent[] = [];
  const errors: Array<[string, unknown]> = [];
  const observer = new McpProtocolObserver(
    'codex',
    server,
    'connection-1',
    (event) => events.push(event),
    { error: (message, error) => errors.push([message, error]) },
  );

  return { observer, events, errors };
}

describe('McpProtocolObserver', () => {
  it('emits a normalized successful tool call without retaining arguments', () => {
    const { observer, events } = fixture();
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(112.6);

    observer.observeClientLine(
      '{"jsonrpc":"2.0","id":"request-1","method":"tools/call","params":{"name":"read_file","arguments":{"path":"/private/secret"}}}',
    );
    observer.observeServerLine(
      '{"jsonrpc":"2.0","id":"request-1","result":{"content":[]}}',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      agent: 'codex',
      sessionId: 'connection-1',
      kind: 'mcp_call',
      name: 'read_file',
      mcpServer: 'filesystem',
      outcome: 'success',
      evidence: 'mcp_proxy',
      precision: 'exact',
      dedupeKey: 'proxy:connection-1:"request-1":1',
    });
    expect(events[0]?.durationMs).toBeCloseTo(12.6);
    expect(events[0]?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(events)).not.toContain('/private/secret');
    expect(JSON.stringify(observer)).not.toContain('/private/secret');
  });

  it('classifies JSON-RPC errors and MCP isError results as failures', () => {
    const { observer, events } = fixture();
    observer.observeClientLine(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"first"}}',
    );
    observer.observeClientLine(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"second"}}',
    );

    observer.observeServerLine(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"nope"}}',
    );
    observer.observeServerLine(
      '{"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[]}}',
    );

    expect(events.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
      { name: 'first', outcome: 'failure' },
      { name: 'second', outcome: 'failure' },
    ]);
  });

  it('handles request and response batches', () => {
    const { observer, events } = fixture();

    observer.observeClientLine(JSON.stringify([
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'alpha' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'beta' } },
    ]));
    observer.observeServerLine(JSON.stringify([
      { jsonrpc: '2.0', id: 11, result: {} },
      { jsonrpc: '2.0', id: 10, error: { code: -1, message: 'bad' } },
    ]));

    expect(events.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
      { name: 'beta', outcome: 'success' },
      { name: 'alpha', outcome: 'failure' },
    ]);
  });

  it('streams batch entries after an empty array value', () => {
    const { observer, events } = fixture();
    observer.observeClientChunk(
      '[{"id":1,"method":"tools/call","params":{"name":"first"}},' +
      '{"id":2,"method":"tools/call","params":{"name":"second"}}]\n',
    );
    observer.endClientStream();
    observer.observeServerChunk(
      '[{"result":[],"id":1},{"result":{},"id":2}]\n',
    );
    observer.endServerStream();

    expect(events.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
      { name: 'first', outcome: 'success' },
      { name: 'second', outcome: 'success' },
    ]);
  });

  it('retains only bounded metadata while streaming a 32 MiB argument string', () => {
    const { observer, events } = fixture();
    observer.observeClientChunk(
      '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":' +
      '{"name":"huge","arguments":{"secret":"',
    );
    const argumentChunk = Buffer.alloc(64 * 1024, 0x78);
    for (let index = 0; index < 512; index += 1) {
      observer.observeClientChunk(argumentChunk);
    }
    const retainedWhileUnterminated = (
      observer as unknown as { bufferedMetadataBytes: number }
    ).bufferedMetadataBytes;

    observer.observeClientChunk('"}}}\n');
    observer.endClientStream();
    observer.observeServerChunk('{"jsonrpc":"2.0","id":99,"result":{}}\n');
    observer.endServerStream();

    expect(retainedWhileUnterminated).toBeLessThanOrEqual(16 * 1024);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'huge', outcome: 'success' });
  });

  it('fails open when tool-name or string-id metadata exceeds its bound', () => {
    const { observer, events } = fixture();
    const oversizedName = 'n'.repeat(4097);
    const oversizedId = 'i'.repeat(1025);

    observer.observeClientChunk(
      `{"id":1,"method":"tools/call","params":{"name":${JSON.stringify(oversizedName)}}}\n`,
    );
    observer.observeClientChunk(
      `{"id":${JSON.stringify(oversizedId)},"method":"tools/call","params":{"name":"tool"}}\n`,
    );
    observer.endClientStream();
    observer.observeServerChunk('{"id":1,"result":{}}\n');
    observer.observeServerChunk(
      `{"id":${JSON.stringify(oversizedId)},"result":{}}\n`,
    );
    observer.endServerStream();

    expect(events).toEqual([]);
  });

  it('correlates requests with long nested argument keys before and after metadata', () => {
    const { observer, events } = fixture();
    const longKey = 'k'.repeat(65);
    observer.observeClientChunk(
      `{"params":{"arguments":{"${longKey}":"before"},"name":"before"},` +
      '"method":"tools/call","id":401}\n',
    );
    observer.observeClientChunk(
      `{"id":402,"method":"tools/call","params":{"name":"after",` +
      `"arguments":{"nested":{"${longKey}":"after"}}}}\n`,
    );
    observer.endClientStream();
    observer.observeServerChunk('{"id":401,"result":{}}\n');
    observer.observeServerChunk('{"id":402,"result":{}}\n');
    observer.endServerStream();

    expect(events.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
      { name: 'before', outcome: 'success' },
      { name: 'after', outcome: 'success' },
    ]);
  });

  it('correlates success and error responses containing long nested result keys', () => {
    const { observer, events } = fixture();
    const longKey = 'r'.repeat(80);
    observer.observeClientChunk(
      '{"id":501,"method":"tools/call","params":{"name":"success"}}\n' +
      '{"id":502,"method":"tools/call","params":{"name":"failure"}}\n',
    );
    observer.endClientStream();
    observer.observeServerChunk(
      `{"result":{"payload":{"${longKey}":"ignored"}},"id":501}\n`,
    );
    observer.observeServerChunk(
      `{"id":502,"error":{"code":-1,"${longKey}":{"value":"ignored"}}}\n`,
    );
    observer.endServerStream();

    expect(events.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
      { name: 'success', outcome: 'success' },
      { name: 'failure', outcome: 'failure' },
    ]);
  });

  it('ignores malformed, notification, non-tool, unmatched, and invalid-name messages', () => {
    const { observer, events } = fixture();

    observer.observeClientLine('{bad json');
    observer.observeClientLine('null');
    observer.observeClientLine('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"notification"}}');
    observer.observeClientLine('{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"name":"resource"}}');
    observer.observeClientLine('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":42}}');
    observer.observeServerLine('{"jsonrpc":"2.0","id":999,"result":{}}');
    observer.observeServerLine('{bad json');
    observer.close();

    expect(events).toEqual([]);
  });

  it('distinguishes string and numeric IDs', () => {
    const { observer, events } = fixture();

    observer.observeClientLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"numeric"}}');
    observer.observeClientLine('{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"string"}}');
    observer.observeServerLine('{"jsonrpc":"2.0","id":"1","result":{}}');
    observer.observeServerLine('{"jsonrpc":"2.0","id":1,"result":{}}');

    expect(events.map(({ name, dedupeKey }) => ({ name, dedupeKey }))).toEqual([
      { name: 'string', dedupeKey: 'proxy:connection-1:"1":1' },
      { name: 'numeric', dedupeKey: 'proxy:connection-1:1:2' },
    ]);
  });

  it('records repeated request IDs as distinct calls on the same connection', () => {
    const { observer, events } = fixture();

    observer.observeClientLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"first"}}');
    observer.observeServerLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    observer.observeClientLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"second"}}');
    observer.observeServerLine('{"jsonrpc":"2.0","id":1,"result":{}}');

    expect(events.map(({ name, dedupeKey }) => ({ name, dedupeKey }))).toEqual([
      { name: 'first', dedupeKey: 'proxy:connection-1:1:1' },
      { name: 'second', dedupeKey: 'proxy:connection-1:1:2' },
    ]);
  });

  it('emits unknown once for each in-flight request when closed', () => {
    const { observer, events } = fixture();
    observer.observeClientLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"unfinished"}}');

    observer.close();
    observer.close();
    observer.observeServerLine('{"jsonrpc":"2.0","id":1,"result":{}}');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'unfinished', outcome: 'unknown' });
  });

  it('ignores calls to the usage-stats self-server', () => {
    const { observer, events } = fixture('usage-stats');
    observer.observeClientLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query"}}');
    observer.observeServerLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    observer.close();

    expect(events).toEqual([]);
  });

  it('swallows and logs synchronous and asynchronous emit failures', async () => {
    const errors: Array<[string, unknown]> = [];
    let attempt = 0;
    const observer = new McpProtocolObserver(
      'codex',
      'filesystem',
      'connection-1',
      () => {
        attempt += 1;
        if (attempt === 1) throw new Error('sync storage failure');
        return Promise.reject(new Error('async storage failure'));
      },
      { error: (message, error) => errors.push([message, error]) },
    );

    observer.observeClientLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"one"}}');
    observer.observeServerLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    observer.observeClientLine('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"two"}}');
    observer.observeServerLine('{"jsonrpc":"2.0","id":2,"result":{}}');
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toHaveLength(2);
    expect(errors.every(([message]) => message === 'Failed to record proxied MCP call')).toBe(true);
  });
});
