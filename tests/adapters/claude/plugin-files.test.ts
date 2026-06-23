import { describe, expect, it } from 'vitest';

import { claudePluginFiles } from '../../../src/adapters/claude/plugin-files.js';

interface HookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

interface HooksJson {
  hooks: Record<string, HookEntry[]>;
}

interface McpJson {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

interface PluginJson {
  name: string;
  version: string;
}

const expectedHookCommand = 'node "${CLAUDE_PLUGIN_ROOT}/runtime/agent-usage.mjs" hook claude';

function readFile(files: Record<string, string>, path: string): string {
  const content = files[path];
  if (content === undefined) {
    throw new Error(`missing expected plugin file: ${path}`);
  }
  return content;
}

function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (match === null || match[1] === undefined) {
    throw new Error('expected YAML frontmatter');
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    fields[key] = value;
  }
  return fields;
}

describe('claudePluginFiles', () => {
  it('returns a map keyed by the expected plugin-relative paths', () => {
    const files = claudePluginFiles();

    expect(files['.claude-plugin/plugin.json']).toBeDefined();
    expect(files['hooks/hooks.json']).toBeDefined();
    expect(files['.mcp.json']).toBeDefined();
    expect(files['skills/usage-stats/SKILL.md']).toBeDefined();
    expect(files['alias/SKILL.md']).toBeDefined();
  });

  describe('plugin manifest', () => {
    it('parses with a name and version', () => {
      const manifest = JSON.parse(
        readFile(claudePluginFiles(), '.claude-plugin/plugin.json'),
      ) as PluginJson;

      expect(typeof manifest.name).toBe('string');
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(typeof manifest.version).toBe('string');
      expect(manifest.version.length).toBeGreaterThan(0);
    });
  });

  describe('hooks', () => {
    it('registers all three hook events using the hidden hook command', () => {
      const parsed = JSON.parse(
        readFile(claudePluginFiles(), 'hooks/hooks.json'),
      ) as HooksJson;
      expect(parsed.hooks.UserPromptExpansion).toBeDefined();
      expect(parsed.hooks.PostToolUse).toBeDefined();
      expect(parsed.hooks.PostToolUseFailure).toBeDefined();

      for (const eventName of [
        'UserPromptExpansion',
        'PostToolUse',
        'PostToolUseFailure',
      ] as const) {
        const entries = parsed.hooks[eventName];
        expect(entries).toBeDefined();
        expect(entries?.length).toBeGreaterThan(0);
        for (const entry of entries ?? []) {
          expect(entry.hooks.length).toBeGreaterThan(0);
          for (const hook of entry.hooks) {
            expect(hook.type).toBe('command');
            expect(hook.command).toBe(expectedHookCommand);
          }
        }
      }
    });

    it('fires PostToolUse on MCP tool names and Skill', () => {
      const parsed = JSON.parse(
        readFile(claudePluginFiles(), 'hooks/hooks.json'),
      ) as HooksJson;

      const postToolUse = parsed.hooks.PostToolUse;
      expect(postToolUse).toBeDefined();
      const matcher = postToolUse?.[0]?.matcher ?? '';
      expect(matcher).toContain('mcp__');
      expect(matcher).toContain('Skill');
    });
  });

  describe('mcp server', () => {
    it('registers a usage-stats server launching the mcp command for claude-code', () => {
      const parsed = JSON.parse(
        readFile(claudePluginFiles(), '.mcp.json'),
      ) as McpJson;

      const server = parsed.mcpServers['usage-stats'];
      expect(server).toBeDefined();
      expect(server?.command).toBe('node');
      expect(server?.args).toEqual([
        '${CLAUDE_PLUGIN_ROOT}/runtime/agent-usage.mjs',
        'mcp',
        '--agent',
        'claude-code',
      ]);
    });
  });

  describe('usage-stats skill', () => {
    it('exposes query_usage with valid frontmatter', () => {
      const skill = claudePluginFiles()['skills/usage-stats/SKILL.md'];

      expect(skill).toContain('query_usage');
      expect(parseFrontmatter(skill ?? '')['name']).toBe('usage-stats');
    });
  });

  describe('alias skill', () => {
    it('has the bare usage-stats name and references query_usage', () => {
      const alias = claudePluginFiles()['alias/SKILL.md'];

      expect(parseFrontmatter(alias ?? '')['name']).toBe('usage-stats');
      expect(alias).toContain('query_usage');
    });
  });

  describe('portability', () => {
    it('uses the CLAUDE_PLUGIN_ROOT placeholder and embeds no absolute build paths', () => {
      const files = claudePluginFiles();

      for (const [path, content] of Object.entries(files)) {
        expect(content, `${path} should embed no absolute build path`).not.toContain(
          'dist/agent-usage.mjs',
        );
        if (path === 'hooks/hooks.json' || path === '.mcp.json') {
          expect(content).toContain('${CLAUDE_PLUGIN_ROOT}');
        }
      }
    });
  });
});
