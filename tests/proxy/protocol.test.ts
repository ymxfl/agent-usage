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
      dedupeKey: 'proxy:connection-1:"request-1"',
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
      { name: 'string', dedupeKey: 'proxy:connection-1:"1"' },
      { name: 'numeric', dedupeKey: 'proxy:connection-1:1' },
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
