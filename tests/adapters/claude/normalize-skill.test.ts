import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { normalizeClaudeHook } from '../../../src/adapters/claude/normalize.js';

const occurredAt = '2026-06-22T08:30:00.000Z';
const deterministicDeps = {
  now: () => new Date(occurredAt),
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
};

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../fixtures/claude-hooks/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

describe('normalizeClaudeHook skill events', () => {
  it('normalizes a direct slash-command skill expansion', () => {
    const event = normalizeClaudeHook(fixture('direct-skill'), deterministicDeps);

    expect(event).toEqual({
      schemaVersion: 1,
      occurredAt,
      agent: 'claude-code',
      sessionId: 'session-direct-123',
      project: 'payments-api',
      kind: 'skill_invocation',
      name: 'release-review',
      skillId: expect.stringMatching(/^claude-code:resolved:[a-f0-9]{16}$/),
      outcome: 'unknown',
      evidence: 'native_hook',
      precision: 'exact',
      dedupeKey:
        'claude-code:native:slash-command:00000000-0000-4000-8000-000000000001',
    });
  });

  it('normalizes a successful model-initiated Skill tool use', () => {
    expect(
      normalizeClaudeHook(fixture('model-skill-success'), deterministicDeps),
    ).toEqual({
      schemaVersion: 1,
      occurredAt,
      agent: 'claude-code',
      sessionId: 'session-model-456',
      project: 'agent-usage',
      kind: 'skill_invocation',
      name: 'test-driven-development',
      skillId: expect.stringMatching(/^claude-code:resolved:[a-f0-9]{16}$/),
      outcome: 'success',
      durationMs: 125,
      evidence: 'native_hook',
      precision: 'exact',
      dedupeKey: 'claude-code:native:tool-use-success-789',
    });
  });

  it('normalizes a failed model-initiated Skill tool use', () => {
    expect(
      normalizeClaudeHook(fixture('model-skill-failure'), deterministicDeps),
    ).toEqual({
      schemaVersion: 1,
      occurredAt,
      agent: 'claude-code',
      sessionId: 'session-model-999',
      project: 'agent-usage',
      kind: 'skill_invocation',
      name: 'incident-response',
      skillId: expect.stringMatching(/^claude-code:resolved:[a-f0-9]{16}$/),
      outcome: 'failure',
      durationMs: 31,
      evidence: 'native_hook',
      precision: 'exact',
      dedupeKey: 'claude-code:native:tool-use-failure-321',
    });
  });

  it('ignores non-slash prompt expansions and slash expansions without a name', () => {
    const direct = fixture('direct-skill') as Record<string, unknown>;

    expect(
      normalizeClaudeHook(
        { ...direct, expansion_type: 'mcp_prompt' },
        deterministicDeps,
      ),
    ).toBeNull();
    expect(
      normalizeClaudeHook({ ...direct, command_name: '' }, deterministicDeps),
    ).toBeNull();
    const { command_name: _, ...withoutName } = direct;
    expect(normalizeClaudeHook(withoutName, deterministicDeps)).toBeNull();
  });

  it('ignores unrelated tool hooks, including case variants of Skill', () => {
    const success = fixture('model-skill-success') as Record<string, unknown>;

    expect(
      normalizeClaudeHook(
        { ...success, tool_name: 'Read' },
        deterministicDeps,
      ),
    ).toBeNull();
    expect(
      normalizeClaudeHook(
        { ...success, tool_name: 'skill' },
        deterministicDeps,
      ),
    ).toBeNull();
  });

  it('throws for malformed common hook identity instead of inventing an event', () => {
    const success = fixture('model-skill-success') as Record<string, unknown>;
    const { session_id: _, ...withoutSession } = success;

    expect(() =>
      normalizeClaudeHook(withoutSession, deterministicDeps),
    ).toThrow();
    expect(() => normalizeClaudeHook({}, deterministicDeps)).toThrow();
  });

  it('requires model Skill tool identity and a nonempty skill name', () => {
    const success = fixture('model-skill-success') as Record<string, unknown>;
    const { tool_use_id: _, ...withoutToolUseId } = success;

    expect(() =>
      normalizeClaudeHook(withoutToolUseId, deterministicDeps),
    ).toThrow();
    expect(() =>
      normalizeClaudeHook(
        { ...success, tool_use_id: '', tool_input: { skill: 'testing' } },
        deterministicDeps,
      ),
    ).toThrow();
    expect(() =>
      normalizeClaudeHook(
        { ...success, tool_input: { skill: '' } },
        deterministicDeps,
      ),
    ).toThrow();
    expect(() =>
      normalizeClaudeHook(
        { ...success, tool_input: {} },
        deterministicDeps,
      ),
    ).toThrow();
  });

  it('never retains hook arguments, prompts, responses, paths, or errors', () => {
    for (const name of [
      'direct-skill',
      'model-skill-success',
      'model-skill-failure',
    ]) {
      const serialized = JSON.stringify(
        normalizeClaudeHook(fixture(name), deterministicDeps),
      );

      expect(serialized).not.toMatch(
        /sensitive|secret|transcript\.jsonl|command_args|prompt|tool_input|tool_response|error/,
      );
    }
  });

  it('uses deterministic dependencies and stable dedupe semantics', () => {
    const first = normalizeClaudeHook(fixture('direct-skill'), deterministicDeps);
    const second = normalizeClaudeHook(fixture('direct-skill'), deterministicDeps);
    const changedInvocation = normalizeClaudeHook(fixture('direct-skill'), {
      ...deterministicDeps,
      randomUUID: () => '00000000-0000-4000-8000-000000000002',
    });
    const model = normalizeClaudeHook(
      fixture('model-skill-success'),
      deterministicDeps,
    );

    expect(first).toEqual(second);
    expect(changedInvocation?.dedupeKey).not.toBe(first?.dedupeKey);
    expect(changedInvocation?.skillId).toBe(first?.skillId);
    expect(model?.dedupeKey).toBe('claude-code:native:tool-use-success-789');
  });

  it('omits a project for a filesystem root cwd', () => {
    const direct = fixture('direct-skill') as Record<string, unknown>;
    const event = normalizeClaudeHook({ ...direct, cwd: '/' }, deterministicDeps);

    expect(event).not.toHaveProperty('project');
  });

  it('rejects a negative duration', () => {
    const success = fixture('model-skill-success') as Record<string, unknown>;

    expect(() =>
      normalizeClaudeHook({ ...success, duration_ms: -1 }, deterministicDeps),
    ).toThrow();
  });
});
