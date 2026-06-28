import { Readable, Writable } from 'node:stream';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { UsageMcpService } from './service.js';

const eventKindSchema = z.enum([
  'skill_session_load',
  'skill_invocation',
  'mcp_call',
]);

const recordSkillInputSchema = z
  .object({
    skill_id: z.string().min(1),
    skill_name: z.string().optional(),
    scope: z.enum(['user', 'project']).optional(),
  })
  .strict();

const queryUsageInputSchema = z
  .object({
    range: z.enum(['today', '7d', '30d', 'all']).default('7d'),
    agent: z.string().min(1).optional(),
    kind: eventKindSchema.optional(),
  })
  .strict();

const recordSkillOutputSchema = z
  .object({
    ok: z.boolean(),
    recorded: z.boolean(),
    next: z.literal('continue'),
  })
  .strict();

const usageReportOutputSchema = z
  .object({
    rangeLabel: z.string(),
    totals: z.array(
      z
        .object({
          agent: z.string(),
          kind: eventKindSchema,
          evidence: z.enum(['native_hook', 'injected_mcp', 'mcp_proxy', 'session_log']),
          precision: z.enum(['exact', 'best_effort']),
          count: z.number(),
        })
        .strict(),
    ),
    topSkills: z.array(
      z
        .object({
          agent: z.string(),
          name: z.string(),
          count: z.number(),
        })
        .strict(),
    ),
    mcp: z.array(
      z
        .object({
          agent: z.string(),
          server: z.string(),
          tool: z.string(),
          success: z.number(),
          failure: z.number(),
          unknown: z.number(),
          averageDurationMs: z.number().nullable(),
        })
        .strict(),
    ),
    warnings: z.array(z.string()),
  })
  .strict();

function toolResult(value: object) {
  return {
    structuredContent: { ...value },
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

export function buildUsageMcpServer(service: UsageMcpService): McpServer {
  const server = new McpServer({ name: 'usage-stats', version: '0.1.0' });

  server.registerTool(
    'record_skill',
    {
      description:
        'Record that the current agent connection loaded a skill, then continue.',
      inputSchema: recordSkillInputSchema,
      outputSchema: recordSkillOutputSchema,
    },
    (input) => toolResult(service.recordSkill(input)),
  );

  server.registerTool(
    'query_usage',
    {
      description:
        'Return an aggregate usage report for a named time range and optional filters.',
      inputSchema: queryUsageInputSchema,
      outputSchema: usageReportOutputSchema,
    },
    (input) => toolResult(service.queryNamedRange(input)),
  );

  return server;
}

/**
 * Optional lifecycle bound to an MCP session. When supplied to
 * {@link runUsageMcpServer}, `start()` runs before the stdio transport connects
 * (so a watcher can begin observing) and `close()` runs when the session ends
 * (so resources are released). Agents that don't supply a lifecycle omit it.
 */
export interface McpLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface McpServerTransportOptions {
  /**
   * Streams the stdio transport reads from / writes to. Defaults to
   * `process.stdin` / `process.stdout`; injected in tests so a full session can
   * be driven in-process over `PassThrough` streams.
   */
  stdin?: Readable;
  stdout?: Writable;
}

export async function runUsageMcpServer(
  service: UsageMcpService,
  lifecycle?: McpLifecycle,
  options: McpServerTransportOptions = {},
): Promise<void> {
  // Start the lifecycle (e.g. begin watching) before connecting the transport,
  // so resources are ready by the time the first request arrives.
  await lifecycle?.start();

  const server = buildUsageMcpServer(service);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  await server.connect(transport);

  // `server.connect` resolves the moment the transport begins listening — it
  // does NOT wait for the session to end (the SDK's StdioServerTransport only
  // invokes `onclose` from its own `close()`, never on stdin EOF). Block here
  // until the session actually finishes (the client disconnects stdin, or a
  // shutdown signal arrives) so callers can keep shared resources — notably
  // the open usage database — alive for the whole session. Without this, the
  // CLI's `finally { database.close() }` would run immediately after connect,
  // finalizing the prepared INSERT statement before any tool call and breaking
  // every record_skill with "statement has been finalized".
  await waitForSessionEnd(stdin, server);

  await lifecycle?.close();
}

/**
 * Resolve once the MCP session ends: the client disconnected (stdin EOF) or a
 * shutdown signal was received. Removes its own listeners and closes the server
 * (and thus the transport) deterministically before resolving.
 */
function waitForSessionEnd(stdin: Readable, server: McpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      stdin.off('end', finish);
      // Close the server before resolving so the transport is torn down
      // deterministically. Resolve regardless so a failed close can't hang the
      // process.
      void server.close().finally(resolve);
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    stdin.once('end', finish);
  });
}
