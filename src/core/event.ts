import { z } from 'zod';

const sharedUsageEventShape = {
  schemaVersion: z.literal(1),
  occurredAt: z.string().datetime(),
  agent: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  name: z.string().min(1),
  outcome: z.enum(['success', 'failure', 'unknown']),
  durationMs: z.number().nonnegative().optional(),
  evidence: z.enum(['native_hook', 'injected_mcp', 'mcp_proxy']),
  precision: z.enum(['exact', 'best_effort']),
  dedupeKey: z.string().min(1),
};

const skillUsageEventShape = {
  ...sharedUsageEventShape,
  skillId: z.string().min(1),
  mcpServer: z.string().min(1).optional(),
};

const usageEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...skillUsageEventShape,
      kind: z.literal('skill_session_load'),
    })
    .strict(),
  z
    .object({
      ...skillUsageEventShape,
      kind: z.literal('skill_invocation'),
    })
    .strict(),
  z
    .object({
      ...sharedUsageEventShape,
      kind: z.literal('mcp_call'),
      skillId: z.string().min(1).optional(),
      mcpServer: z.string().min(1),
    })
    .strict(),
]);

export type UsageEvent = z.infer<typeof usageEventSchema>;

export function parseUsageEvent(input: unknown): UsageEvent {
  return usageEventSchema.parse(input);
}
