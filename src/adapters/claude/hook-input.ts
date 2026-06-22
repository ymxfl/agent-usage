import { z } from 'zod';

const nonemptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'Expected a nonempty string',
});

export const claudeHookSchema = z
  .object({
    session_id: nonemptyString,
    cwd: nonemptyString,
    hook_event_name: nonemptyString,
  })
  .passthrough();

export const claudeUserPromptExpansionSchema = claudeHookSchema.extend({
  hook_event_name: z.literal('UserPromptExpansion'),
  expansion_type: nonemptyString,
  command_name: z.string().optional(),
});

const claudeToolHookShape = {
  tool_name: nonemptyString,
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: nonemptyString,
  duration_ms: z.number().finite().nonnegative().optional(),
};

export const claudePostToolUseSchema = claudeHookSchema.extend({
  hook_event_name: z.literal('PostToolUse'),
  ...claudeToolHookShape,
});

export const claudePostToolUseFailureSchema = claudeHookSchema.extend({
  hook_event_name: z.literal('PostToolUseFailure'),
  ...claudeToolHookShape,
});

export const claudeSkillToolInputSchema = z
  .object({
    skill: nonemptyString.optional(),
    name: nonemptyString.optional(),
  })
  .passthrough()
  .refine((input) => input.skill !== undefined || input.name !== undefined, {
    message: 'Skill tool input requires a skill name',
  });

export type ClaudeHookInput = z.infer<typeof claudeHookSchema>;
export type ClaudeUserPromptExpansionInput = z.infer<
  typeof claudeUserPromptExpansionSchema
>;
export type ClaudePostToolUseInput = z.infer<typeof claudePostToolUseSchema>;
export type ClaudePostToolUseFailureInput = z.infer<
  typeof claudePostToolUseFailureSchema
>;
