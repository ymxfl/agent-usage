import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { UsageEvent } from '../../src/core/event.js';
import type { UsageReport } from '../../src/core/query.js';
import {
  UsageMcpService,
  type UsageMcpRepository,
} from '../../src/mcp/service.js';
import { buildUsageMcpServer } from '../../src/mcp/server.js';

const report: UsageReport = {
  rangeLabel: 'all',
  totals: [
    {
      agent: 'codex',
      kind: 'skill_session_load',
      evidence: 'injected_mcp',
      precision: 'best_effort',
      count: 1,
    },
  ],
  topSkills: [{ agent: 'codex', name: 'Testing', count: 1 }],
  mcp: [],
  warnings: ['Injected MCP skill usage is best-effort and may be incomplete.'],
};

interface Connection {
  client: Client;
  close(): Promise<void>;
}

const openConnections: Connection[] = [];

function repositoryFixture(): {
  events: UsageEvent[];
  repository: UsageMcpRepository;
} {
  const events: UsageEvent[] = [];
  return {
    events,
    repository: {
      insert(event) {
        events.push(event);
        return true;
      },
      report() {
        return report;
      },
    },
  };
}

async function connect(service: UsageMcpService): Promise<Connection> {
  const server = buildUsageMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'usage-stats-test', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const connection = {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
  openConnections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.allSettled(openConnections.splice(0).map(({ close }) => close()));
});

describe('usage MCP server', () => {
  it('identifies itself and lists exactly the two accounting tools', async () => {
    const fixture = repositoryFixture();
    const { client } = await connect(
      new UsageMcpService(fixture.repository, 'codex', 'connection-1'),
    );

    expect(client.getServerVersion()).toEqual({
      name: 'usage-stats',
      version: '0.1.0',
    });
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([
      'record_skill',
      'query_usage',
    ]);
    expect(listed.tools).toEqual([
      expect.objectContaining({
        name: 'record_skill',
        description: expect.any(String),
        inputSchema: expect.objectContaining({ required: ['skill_id'] }),
      }),
      expect.objectContaining({
        name: 'query_usage',
        description: expect.any(String),
      }),
    ]);
  });

  it('returns record_skill results as matching structured and JSON text content', async () => {
    const fixture = repositoryFixture();
    const { client } = await connect(
      new UsageMcpService(fixture.repository, 'codex', 'connection-1'),
    );

    const result = await client.callTool({
      name: 'record_skill',
      arguments: {
        skill_id: 'codex:project:skill-1',
        skill_name: 'Testing',
        scope: 'project',
      },
    });

    const expected = { ok: true, recorded: true, next: 'continue' };
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(expected) },
    ]);
    expect(fixture.events).toHaveLength(1);
  });

  it('returns query_usage reports as matching structured and JSON text content', async () => {
    const fixture = repositoryFixture();
    const { client } = await connect(
      new UsageMcpService(fixture.repository, 'codex', 'connection-1'),
    );

    const result = await client.callTool({
      name: 'query_usage',
      arguments: {
        range: 'all',
        agent: 'codex',
        kind: 'skill_session_load',
      },
    });

    expect(result.structuredContent).toEqual(report);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(report) },
    ]);
  });

  it('rejects invalid tool input with MCP validation errors and remains available', async () => {
    const fixture = repositoryFixture();
    const { client } = await connect(
      new UsageMcpService(fixture.repository, 'codex', 'connection-1'),
    );

    const invalidRecord = await client.callTool({
      name: 'record_skill',
      arguments: { skill_id: '' },
    });
    const invalidQuery = await client.callTool({
      name: 'query_usage',
      arguments: { range: 'yesterday' },
    });

    for (const result of [invalidRecord, invalidQuery]) {
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: expect.stringContaining(
              `MCP error ${ErrorCode.InvalidParams}: Input validation error`,
            ),
          },
        ],
      });
    }
    await expect(client.ping()).resolves.toEqual({});
    expect(fixture.events).toEqual([]);
  });
});
