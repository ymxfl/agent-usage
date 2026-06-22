import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { normalizeClaudeHook } from '../../../src/adapters/claude/normalize.js';

const occurredAt = '2026-06-22T10:15:00.000Z';
const deterministicDeps = {
  now: () => new Date(occurredAt),
  randomUUID: () => '00000000-0000-4000-8000-000000000003',
};

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../fixtures/claude-hooks/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

describe('normalizeClaudeHook MCP events', () => {
  it('normalizes MCP success and preserves valid name delimiters', () => {
    expect(
      normalizeClaudeHook(fixture('mcp-success'), deterministicDeps),
    ).toEqual({
      schemaVersion: 1,
      occurredAt,
      agent: 'claude-code',
      sessionId: 'session-mcp-success',
      project: 'payments-api',
      kind: 'mcp_call',
      mcpServer: 'github_enterprise-v2',
      name: 'search_repositories__advanced',
      outcome: 'success',
      durationMs: 47,
      evidence: 'native_hook',
      precision: 'exact',
      dedupeKey: 'claude-code:native:tool-use-mcp-success',
    });
  });

  it('normalizes MCP failure', () => {
    expect(
      normalizeClaudeHook(fixture('mcp-failure'), deterministicDeps),
    ).toEqual({
      schemaVersion: 1,
      occurredAt,
      agent: 'claude-code',
      sessionId: 'session-mcp-failure',
      project: 'incident-console',
      kind: 'mcp_call',
      mcpServer: 'sentry-cloud',
      name: 'create_issue',
      outcome: 'failure',
      durationMs: 19,
      evidence: 'native_hook',
      precision: 'exact',
      dedupeKey: 'claude-code:native:tool-use-mcp-failure',
    });
  });

  it('splits at the first remaining double underscore', () => {
    const success = fixture('mcp-success') as Record<string, unknown>;
    const event = normalizeClaudeHook(
      {
        ...success,
        tool_name: 'mcp__server_name-with-hyphen__tool__with__segments',
      },
      deterministicDeps,
    );

    expect(event).toMatchObject({
      mcpServer: 'server_name-with-hyphen',
      name: 'tool__with__segments',
    });
  });

  it.each([
    'usage-stats',
    'agent-usage',
    'plugin_agent-usage_usage-stats',
    'plugin_agent_usage_usage_stats',
  ])('excludes accounting server %s', (server) => {
    const success = fixture('mcp-success') as Record<string, unknown>;

    expect(
      normalizeClaudeHook(
        { ...success, tool_name: `mcp__${server}__record_skill` },
        deterministicDeps,
      ),
    ).toBeNull();
  });

  it('rejects empty delimiter components and ignores non-MCP tools', () => {
    const success = fixture('mcp-success') as Record<string, unknown>;

    for (const toolName of [
      'mcp__server',
      'mcp____tool',
      'mcp__server__',
      'mcp_server__tool',
      'Read',
    ]) {
      expect(
        normalizeClaudeHook(
          { ...success, tool_name: toolName },
          deterministicDeps,
        ),
      ).toBeNull();
    }
  });

  it('throws for malformed native MCP identity', () => {
    const success = fixture('mcp-success') as Record<string, unknown>;

    expect(() =>
      normalizeClaudeHook(
        { ...success, tool_use_id: '' },
        deterministicDeps,
      ),
    ).toThrow();
  });

  it('never retains MCP arguments, results, errors, or secrets', () => {
    for (const name of ['mcp-success', 'mcp-failure']) {
      const serialized = JSON.stringify(
        normalizeClaudeHook(fixture(name), deterministicDeps),
      );

      expect(serialized).not.toMatch(
        /sensitive|secret|private|tool_input|tool_response|error|query|description/,
      );
    }
  });

  it('keeps Skill normalization unchanged', () => {
    expect(
      normalizeClaudeHook(fixture('model-skill-success'), deterministicDeps),
    ).toMatchObject({
      kind: 'skill_invocation',
      name: 'test-driven-development',
      outcome: 'success',
      dedupeKey: 'claude-code:native:tool-use-success-789',
    });
  });
});
