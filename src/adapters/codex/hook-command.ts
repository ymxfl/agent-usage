import type { UsageEvent } from '../../core/event.js';
import {
  emptyAgentSelection,
  selectedMcp,
  type AgentSelectionPolicy,
  type SelectionConfig,
} from '../../core/selection.js';
import {
  CODEX_ADAPTER_ID,
  normalizeCodexHook,
  type CodexNormalizerDependencies,
} from './normalize.js';

export type CodexHookOutcome = 'recorded' | 'ignored' | 'failed';

export type { CodexNormalizerDependencies };

export interface CodexHookDependencies {
  loadSelectionConfig: () => Promise<SelectionConfig>;
  insert: (event: UsageEvent) => boolean;
  logError: (message: string, error: unknown) => void | Promise<void>;
  normalizerDependencies: CodexNormalizerDependencies;
}

async function logSafely(
  logError: CodexHookDependencies['logError'],
  message: string,
  error: unknown,
): Promise<void> {
  try {
    await logError(message, error);
  } catch {
    // Hook diagnostics are best-effort and must never block Codex.
  }
}

export async function consumeCodexHook(
  text: string,
  dependencies: CodexHookDependencies,
): Promise<CodexHookOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    await logSafely(dependencies.logError, 'Failed to consume Codex hook', error);
    return 'failed';
  }

  let event: UsageEvent | null;
  try {
    event = normalizeCodexHook(parsed, dependencies.normalizerDependencies);
  } catch (error) {
    await logSafely(dependencies.logError, 'Failed to consume Codex hook', error);
    return 'failed';
  }

  if (event === null) return 'ignored';

  let config: SelectionConfig;
  try {
    config = await dependencies.loadSelectionConfig();
  } catch (error) {
    await logSafely(dependencies.logError, 'Failed to consume Codex hook', error);
    return 'failed';
  }

  const policy: AgentSelectionPolicy =
    config.agents[CODEX_ADAPTER_ID] ?? emptyAgentSelection();
  const shouldRecord =
    event.kind === 'mcp_call' &&
    event.mcpServer !== undefined &&
    selectedMcp(policy, event.mcpServer, event.name);

  if (!shouldRecord) return 'ignored';

  try {
    dependencies.insert(event);
  } catch (error) {
    await logSafely(dependencies.logError, 'Failed to consume Codex hook', error);
    return 'failed';
  }

  return 'recorded';
}
