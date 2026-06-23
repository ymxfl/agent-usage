import type { UsageEvent } from '../../core/event.js';
import {
  emptyAgentSelection,
  selectedMcp,
  selectedSkillMode,
  type AgentSelectionPolicy,
  type SelectionConfig,
} from '../../core/selection.js';
import {
  normalizeClaudeHook,
  type ClaudeNormalizerDependencies,
} from './normalize.js';

export type ClaudeHookOutcome = 'recorded' | 'ignored' | 'failed';

export type { ClaudeNormalizerDependencies };

export interface ClaudeHookDependencies {
  loadSelectionConfig: () => Promise<SelectionConfig>;
  insert: (event: UsageEvent) => boolean;
  logError: (message: string, error: unknown) => void | Promise<void>;
  normalizerDependencies: ClaudeNormalizerDependencies;
}

async function logSafely(
  logError: ClaudeHookDependencies['logError'],
  message: string,
  error: unknown,
): Promise<void> {
  try {
    await logError(message, error);
  } catch {
    // Diagnostic logging must never interfere with hook consumption.
  }
}

export async function consumeClaudeHook(
  text: string,
  dependencies: ClaudeHookDependencies,
): Promise<ClaudeHookOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    await logSafely(dependencies.logError, 'Failed to consume Claude hook', error);
    return 'failed';
  }

  let event: UsageEvent | null;
  try {
    event = normalizeClaudeHook(parsed, dependencies.normalizerDependencies);
  } catch (error) {
    await logSafely(dependencies.logError, 'Failed to consume Claude hook', error);
    return 'failed';
  }

  if (event === null) return 'ignored';

  let config: SelectionConfig;
  try {
    config = await dependencies.loadSelectionConfig();
  } catch (error) {
    await logSafely(dependencies.logError, 'Failed to consume Claude hook', error);
    return 'failed';
  }

  const policy: AgentSelectionPolicy =
    config.agents['claude-code'] ?? emptyAgentSelection();

  let shouldRecord: boolean;
  if (event.kind === 'skill_invocation') {
    let mode;
    try {
      mode = selectedSkillMode(policy, event.name);
    } catch (error) {
      await logSafely(
        dependencies.logError,
        'Conflicting Claude Skill selection',
        error,
      );
      return 'failed';
    }
    shouldRecord = mode === 'native_hook';
  } else if (event.kind === 'mcp_call' && event.mcpServer !== undefined) {
    shouldRecord = selectedMcp(policy, event.mcpServer, event.name);
  } else {
    shouldRecord = false;
  }

  if (!shouldRecord) return 'ignored';

  try {
    dependencies.insert(event);
  } catch (error) {
    await logSafely(dependencies.logError, 'Failed to consume Claude hook', error);
    return 'failed';
  }

  return 'recorded';
}
