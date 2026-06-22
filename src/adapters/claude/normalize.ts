import { createHash, randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';

import { parseUsageEvent, type UsageEvent } from '../../core/event.js';
import { nativeDedupeKey } from '../../core/identity.js';
import {
  claudeHookSchema,
  claudePostToolUseFailureSchema,
  claudePostToolUseSchema,
  claudeSkillToolInputSchema,
  claudeUserPromptExpansionSchema,
  type ClaudePostToolUseFailureInput,
  type ClaudePostToolUseInput,
} from './hook-input.js';

const agent = 'claude-code';

export interface ClaudeNormalizerDependencies {
  now?: () => Date;
  randomUUID?: () => string;
}

function resolvedSkillId(name: string): string {
  const digest = createHash('sha256')
    .update(name)
    .digest('hex')
    .slice(0, 16);

  return `${agent}:resolved:${digest}`;
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

function normalizeToolSkill(
  input: ClaudePostToolUseInput | ClaudePostToolUseFailureInput,
  occurredAt: string,
): UsageEvent | null {
  if (input.tool_name !== 'Skill') return null;

  const toolInput = claudeSkillToolInputSchema.parse(input.tool_input);
  const name = (toolInput.skill ?? toolInput.name)?.trim();

  if (name === undefined) {
    throw new Error('Skill tool input requires a skill name');
  }

  const project = projectFromCwd(input.cwd);

  return parseUsageEvent({
    schemaVersion: 1,
    occurredAt,
    agent,
    sessionId: input.session_id,
    ...(project === undefined ? {} : { project }),
    kind: 'skill_invocation',
    name,
    skillId: resolvedSkillId(name),
    outcome: input.hook_event_name === 'PostToolUseFailure'
      ? 'failure'
      : 'success',
    ...(input.duration_ms === undefined
      ? {}
      : { durationMs: input.duration_ms }),
    evidence: 'native_hook',
    precision: 'exact',
    dedupeKey: nativeDedupeKey(agent, input.tool_use_id),
  });
}

export function normalizeClaudeHook(
  raw: unknown,
  dependencies: ClaudeNormalizerDependencies = {},
): UsageEvent | null {
  const common = claudeHookSchema.parse(raw);
  const occurredAt = (dependencies.now ?? (() => new Date()))().toISOString();

  if (common.hook_event_name === 'UserPromptExpansion') {
    const input = claudeUserPromptExpansionSchema.parse(raw);

    if (input.expansion_type !== 'slash_command') return null;

    const name = input.command_name?.trim();
    if (name === undefined || name.length === 0) return null;

    const project = projectFromCwd(input.cwd);
    const invocationId = (dependencies.randomUUID ?? randomUUID)();

    return parseUsageEvent({
      schemaVersion: 1,
      occurredAt,
      agent,
      sessionId: input.session_id,
      ...(project === undefined ? {} : { project }),
      kind: 'skill_invocation',
      name,
      skillId: resolvedSkillId(name),
      outcome: 'unknown',
      evidence: 'native_hook',
      precision: 'exact',
      dedupeKey: nativeDedupeKey(agent, `slash-command:${invocationId}`),
    });
  }

  if (common.hook_event_name === 'PostToolUse') {
    return normalizeToolSkill(
      claudePostToolUseSchema.parse(raw),
      occurredAt,
    );
  }

  if (common.hook_event_name === 'PostToolUseFailure') {
    return normalizeToolSkill(
      claudePostToolUseFailureSchema.parse(raw),
      occurredAt,
    );
  }

  return null;
}
