/**
 * Deterministic templates for the user-level "skills-directory plugin" that the
 * Claude Code adapter installs. Each entry maps a plugin-relative path to the
 * file's string contents. A later adapter task copies these files into
 * `~/.claude/skills/agent-usage-plugin/<path>` (and copies the bundled
 * `dist/agent-usage.mjs` into `runtime/`).
 *
 * This function performs no filesystem I/O and references no absolute local
 * paths: build artifacts are addressed via the `${CLAUDE_PLUGIN_ROOT}`
 * placeholder so the templates stay portable.
 */
export function claudePluginFiles(): Record<string, string> {
  const hookCommand = 'node "${CLAUDE_PLUGIN_ROOT}/runtime/agent-usage.mjs" hook claude';

  return {
    '.claude-plugin/plugin.json': JSON.stringify(
      {
        name: 'agent-usage',
        displayName: 'Agent Usage',
        version: '0.1.0',
        description: 'Local MCP and Skill usage statistics',
      },
      null,
      2,
    ),
    'hooks/hooks.json': JSON.stringify(
      {
        hooks: {
          UserPromptExpansion: [
            {
              matcher: '.*',
              hooks: [{ type: 'command', command: hookCommand }],
            },
          ],
          PostToolUse: [
            {
              matcher: '^(Skill|mcp__.*)$',
              hooks: [{ type: 'command', command: hookCommand }],
            },
          ],
          PostToolUseFailure: [
            {
              matcher: '^(Skill|mcp__.*)$',
              hooks: [{ type: 'command', command: hookCommand }],
            },
          ],
        },
      },
      null,
      2,
    ),
    '.mcp.json': JSON.stringify(
      {
        mcpServers: {
          'usage-stats': {
            command: 'node',
            args: [
              '${CLAUDE_PLUGIN_ROOT}/runtime/agent-usage.mjs',
              'mcp',
              '--agent',
              'claude-code',
            ],
          },
        },
      },
      null,
      2,
    ),
    'skills/usage-stats/SKILL.md': [
      '---',
      'name: usage-stats',
      'description: Use when the user asks to inspect local Skill or MCP usage statistics.',
      '---',
      'Call the `query_usage` tool from the `usage-stats` MCP server using `$ARGUMENTS` as the range/filter. Render the returned structured data without querying raw files.',
      '',
    ].join('\n'),
    'alias/SKILL.md': [
      '---',
      'name: usage-stats',
      'description: Use when the user asks to inspect local Skill or MCP usage statistics.',
      '---',
      'Call the `query_usage` tool from the `usage-stats` MCP server using `$ARGUMENTS` as the range/filter.',
      '',
    ].join('\n'),
  };
}
