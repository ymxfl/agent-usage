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
          evidence: z.enum(['native_hook', 'injected_mcp', 'mcp_proxy']),
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

export async function runUsageMcpServer(
  service: UsageMcpService,
): Promise<void> {
  const server = buildUsageMcpServer(service);
  await server.connect(new StdioServerTransport());
}
