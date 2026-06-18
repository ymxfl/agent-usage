import { z } from 'zod';

const usageEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    occurredAt: z.string().datetime(),
    agent: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    kind: z.enum(['skill_session_load', 'skill_invocation', 'mcp_call']),
    name: z.string().min(1),
    skillId: z.string().min(1).optional(),
    mcpServer: z.string().min(1).optional(),
    outcome: z.enum(['success', 'failure', 'unknown']),
    durationMs: z.number().nonnegative().optional(),
    evidence: z.enum(['native_hook', 'injected_mcp', 'mcp_proxy']),
    precision: z.enum(['exact', 'best_effort']),
    dedupeKey: z.string().min(1),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.kind !== 'mcp_call' && event.skillId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'skillId is required for skill events',
        path: ['skillId'],
      });
    }

    if (event.kind === 'mcp_call' && event.mcpServer === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'mcpServer is required for mcp_call events',
        path: ['mcpServer'],
      });
    }
  });

export type UsageEvent = z.infer<typeof usageEventSchema>;

export function parseUsageEvent(input: unknown): UsageEvent {
  return usageEventSchema.parse(input);
}
