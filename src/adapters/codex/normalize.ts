import { posix, win32 } from 'node:path';

import { z } from 'zod';

import { parseUsageEvent, type UsageEvent } from '../../core/event.js';
import { nativeDedupeKey } from '../../core/identity.js';

export const CODEX_ADAPTER_ID = 'codex';

const mcpPrefix = 'mcp__';
const excludedMcpServers = new Set([
  'usage-stats',
  'agent-usage',
  'plugin_agent-usage_usage-stats',
  'plugin_agent_usage_usage_stats',
]);

const codexHookSchema = z
  .object({
    hook_event_name: z.string().optional(),
    event: z.string().optional(),
    session_id: z.string().min(1),
    cwd: z.string().min(1),
    tool_use_id: z.string().min(1),
    tool_name: z.string().min(1),
    duration_ms: z.number().nonnegative().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.hook_event_name === undefined && value.event === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Codex hook payload requires hook_event_name or event',
        path: ['hook_event_name'],
      });
    }
  });

export interface CodexNormalizerDependencies {
  now?: () => Date;
}

function projectFromCwd(cwd: string): string | undefined {
  const candidate = cwd.includes('\\')
    ? win32.basename(cwd)
    : posix.basename(cwd);

  if (
    candidate.length === 0 ||
    candidate.trim().length === 0 ||
    candidate === '.' ||
    candidate === '..'
  ) {
    return undefined;
  }

  return candidate;
}

function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  if (!toolName.startsWith(mcpPrefix)) return null;

  const remainder = toolName.slice(mcpPrefix.length);
  const separatorIndex = remainder.indexOf('__');
  if (separatorIndex <= 0) return null;

  const server = remainder.slice(0, separatorIndex);
  const tool = remainder.slice(separatorIndex + 2);
  if (tool.length === 0) return null;

  return { server, tool };
}

export function normalizeCodexHook(
  raw: unknown,
  dependencies: CodexNormalizerDependencies = {},
): UsageEvent | null {
  const input = codexHookSchema.parse(raw);
  const eventName = input.hook_event_name ?? input.event;

  if (eventName !== 'PostToolUse' && eventName !== 'PostToolUseFailure') {
    return null;
  }

  const name = parseMcpToolName(input.tool_name);
  if (name === null || excludedMcpServers.has(name.server)) return null;

  const occurredAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const project = projectFromCwd(input.cwd);

  return parseUsageEvent({
    schemaVersion: 1,
    occurredAt,
    agent: CODEX_ADAPTER_ID,
    sessionId: input.session_id,
    ...(project === undefined ? {} : { project }),
    kind: 'mcp_call',
    mcpServer: name.server,
    name: name.tool,
    outcome: eventName === 'PostToolUseFailure' ? 'failure' : 'success',
    ...(input.duration_ms === undefined
      ? {}
      : { durationMs: input.duration_ms }),
    evidence: 'native_hook',
    precision: 'exact',
    dedupeKey: nativeDedupeKey(CODEX_ADAPTER_ID, input.tool_use_id),
  });
}
