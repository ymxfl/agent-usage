# Claude Code Usage Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact Claude Code Skill and MCP telemetry through a global skills-directory plugin while preserving the public `/usage-stats` command.

**Architecture:** Claude hook payloads are normalized into the core event schema and written fail-open. A personal skills-directory plugin bundles hooks, the accounting MCP server, and the runtime; a separate installer-owned plain Skill provides the unnamespaced `/usage-stats` alias.

**Tech Stack:** Existing TypeScript runtime, Claude Code 2.1.161+ plugin hooks, official `UserPromptExpansion`, `PostToolUse`, and `PostToolUseFailure` events, Vitest fixtures.

---

## File Map

- `src/adapters/claude/hook-input.ts`: Claude hook input schemas.
- `src/adapters/claude/normalize.ts`: native hook to core-event translation.
- `src/adapters/claude/hook-command.ts`: stdin consumer with fail-open behavior.
- `src/adapters/claude/plugin-files.ts`: deterministic plugin and alias file templates.
- `src/adapters/claude/adapter.ts`: install, sync, health, and uninstall lifecycle.
- `src/adapters/registry.ts`: register the Claude adapter.
- `tests/fixtures/claude-hooks/*.json`: official-shape hook payloads.
- `tests/adapters/claude/*.test.ts`: normalization, plugin, and lifecycle coverage.

### Task 1: Normalize Claude Skill Hook Events

**Files:**
- Create: `src/adapters/claude/hook-input.ts`
- Create: `src/adapters/claude/normalize.ts`
- Create: `tests/fixtures/claude-hooks/direct-skill.json`
- Create: `tests/fixtures/claude-hooks/model-skill-success.json`
- Create: `tests/fixtures/claude-hooks/model-skill-failure.json`
- Create: `tests/adapters/claude/normalize-skill.test.ts`

- [ ] **Step 1: Write failing direct and model-triggered Skill tests**

```ts
// tests/adapters/claude/normalize-skill.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeClaudeHook } from '../../../src/adapters/claude/normalize.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/claude-hooks/${name}.json`, import.meta.url), 'utf8'));

describe('normalizeClaudeHook Skill paths', () => {
  it('counts a directly typed slash Skill through UserPromptExpansion', () => {
    expect(normalizeClaudeHook(fixture('direct-skill'))).toMatchObject({
      agent: 'claude-code', kind: 'skill_invocation', name: 'deploy',
      outcome: 'unknown', evidence: 'native_hook', precision: 'exact'
    });
  });

  it('counts model-triggered Skill success and failure by tool_use_id', () => {
    expect(normalizeClaudeHook(fixture('model-skill-success'))).toMatchObject({ outcome: 'success', dedupeKey: 'claude-code:native:toolu_skill_1' });
    expect(normalizeClaudeHook(fixture('model-skill-failure'))).toMatchObject({ outcome: 'failure', dedupeKey: 'claude-code:native:toolu_skill_2' });
  });
});
```

- [ ] **Step 2: Add fixture payloads and verify RED**

```json
// tests/fixtures/claude-hooks/direct-skill.json
{"session_id":"session-1","cwd":"/work/app","hook_event_name":"UserPromptExpansion","expansion_type":"slash_command","command_name":"deploy","command_args":"prod","command_source":"user","prompt":"/deploy prod"}
```

```json
// tests/fixtures/claude-hooks/model-skill-success.json
{"session_id":"session-1","cwd":"/work/app","hook_event_name":"PostToolUse","tool_name":"Skill","tool_input":{"skill":"deploy"},"tool_response":{"success":true},"tool_use_id":"toolu_skill_1","duration_ms":12}
```

```json
// tests/fixtures/claude-hooks/model-skill-failure.json
{"session_id":"session-1","cwd":"/work/app","hook_event_name":"PostToolUseFailure","tool_name":"Skill","tool_input":{"skill":"deploy"},"tool_use_id":"toolu_skill_2","error":"load failed","duration_ms":4}
```

Run: `npm test -- tests/adapters/claude/normalize-skill.test.ts`

Expected: FAIL because the normalizer does not exist.

- [ ] **Step 3: Implement strict-enough input parsing and Skill normalization**

```ts
// src/adapters/claude/hook-input.ts
import { z } from 'zod';
export const claudeHookSchema = z.object({
  session_id: z.string(), cwd: z.string(), hook_event_name: z.string(),
  tool_name: z.string().optional(), tool_input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(), duration_ms: z.number().optional(),
  command_name: z.string().optional(), expansion_type: z.string().optional()
}).passthrough();
export type ClaudeHookInput = z.infer<typeof claudeHookSchema>;
```

```ts
// src/adapters/claude/normalize.ts
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { claudeHookSchema } from './hook-input.js';
import { nativeDedupeKey } from '../../core/identity.js';
import type { UsageEvent } from '../../core/event.js';

const skillId = (name: string) => `claude-code:resolved:${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
export function normalizeClaudeHook(raw: unknown): UsageEvent | null {
  const input = claudeHookSchema.parse(raw);
  if (input.hook_event_name === 'UserPromptExpansion' && input.expansion_type === 'slash_command' && input.command_name) {
    return { schemaVersion: 1, occurredAt: new Date().toISOString(), agent: 'claude-code', sessionId: input.session_id,
      project: basename(input.cwd), kind: 'skill_invocation', name: input.command_name, skillId: skillId(input.command_name),
      outcome: 'unknown', evidence: 'native_hook', precision: 'exact',
      dedupeKey: `claude-code:expansion:${input.session_id}:${randomUUID()}` };
  }
  if (input.tool_name !== 'Skill' || !input.tool_use_id) return null;
  const name = String(input.tool_input?.skill ?? input.tool_input?.name ?? 'unknown');
  return { schemaVersion: 1, occurredAt: new Date().toISOString(), agent: 'claude-code', sessionId: input.session_id,
    project: basename(input.cwd), kind: 'skill_invocation', name, skillId: skillId(name),
    outcome: input.hook_event_name === 'PostToolUseFailure' ? 'failure' : 'success',
    ...(input.duration_ms === undefined ? {} : { durationMs: input.duration_ms }),
    evidence: 'native_hook', precision: 'exact', dedupeKey: nativeDedupeKey('claude-code', input.tool_use_id) };
}
```

- [ ] **Step 4: Verify Skill normalization**

Run: `npm test -- tests/adapters/claude/normalize-skill.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit Skill hook normalization**

```bash
git add src/adapters/claude tests/adapters/claude tests/fixtures/claude-hooks
git commit -m "feat: normalize claude skill hooks"
```

### Task 2: Normalize Claude MCP Hook Events

**Files:**
- Modify: `src/adapters/claude/normalize.ts`
- Create: `tests/fixtures/claude-hooks/mcp-success.json`
- Create: `tests/fixtures/claude-hooks/mcp-failure.json`
- Create: `tests/adapters/claude/normalize-mcp.test.ts`

- [ ] **Step 1: Write failing MCP success/failure tests**

```ts
// tests/adapters/claude/normalize-mcp.test.ts
import { expect, it } from 'vitest';
import { normalizeClaudeHook } from '../../../src/adapters/claude/normalize.js';

it('splits mcp__server__tool without storing tool input', () => {
  const event = normalizeClaudeHook({ session_id: 's', cwd: '/work', hook_event_name: 'PostToolUse',
    tool_name: 'mcp__github__search_repositories', tool_input: { query: 'secret' },
    tool_use_id: 'toolu_mcp_1', duration_ms: 30 });
  expect(event).toMatchObject({ kind: 'mcp_call', mcpServer: 'github', name: 'search_repositories', outcome: 'success', durationMs: 30 });
  expect(JSON.stringify(event)).not.toContain('secret');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/claude/normalize-mcp.test.ts`

Expected: FAIL because MCP names currently return null.

- [ ] **Step 3: Add MCP-name parsing before the Skill branch**

```ts
const mcpMatch = input.tool_name?.match(/^mcp__([^_]+(?:_[^_]+)*)__([\s\S]+)$/);
if (mcpMatch && input.tool_use_id) {
  const [, server, tool] = mcpMatch;
  return { schemaVersion: 1, occurredAt: new Date().toISOString(), agent: 'claude-code', sessionId: input.session_id,
    project: basename(input.cwd), kind: 'mcp_call', name: tool!, mcpServer: server!,
    outcome: input.hook_event_name === 'PostToolUseFailure' ? 'failure' : 'success',
    ...(input.duration_ms === undefined ? {} : { durationMs: input.duration_ms }),
    evidence: 'native_hook', precision: 'exact', dedupeKey: nativeDedupeKey('claude-code', input.tool_use_id) };
}
```

- [ ] **Step 4: Verify both MCP and Skill suites**

Run: `npm test -- tests/adapters/claude && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit MCP normalization**

```bash
git add src/adapters/claude/normalize.ts tests/adapters/claude/normalize-mcp.test.ts tests/fixtures/claude-hooks
git commit -m "feat: normalize claude mcp hooks"
```

### Task 3: Add a Fail-Open Hook Command

**Files:**
- Create: `src/adapters/claude/hook-command.ts`
- Modify: `src/cli.ts`
- Create: `tests/adapters/claude/hook-command.test.ts`

- [ ] **Step 1: Write failing stdin and malformed-input tests**

```ts
// tests/adapters/claude/hook-command.test.ts
import { expect, it, vi } from 'vitest';
import { consumeClaudeHook } from '../../../src/adapters/claude/hook-command.js';

it('returns success when malformed telemetry cannot be recorded', async () => {
  const log = vi.fn();
  await expect(consumeClaudeHook('{bad json', { insert: vi.fn() } as never, log)).resolves.toBeUndefined();
  expect(log).toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/claude/hook-command.test.ts`

Expected: FAIL because the command does not exist.

- [ ] **Step 3: Implement fail-open consumption**

```ts
// src/adapters/claude/hook-command.ts
import type { UsageRepository } from '../../core/repository.js';
import { normalizeClaudeHook } from './normalize.js';

export async function consumeClaudeHook(text: string, repository: UsageRepository, log: (error: unknown) => void): Promise<void> {
  try { const event = normalizeClaudeHook(JSON.parse(text)); if (event) repository.insert(event); }
  catch (error) { log(error); }
}
```

Add a hidden `hook claude` CLI command that reads all stdin, invokes `consumeClaudeHook`, writes no stdout, and always exits 0. Append errors to `usagePaths().errors`.

```ts
program.command('hook claude', { hidden: true }).action(async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk.toString();
  const paths = usagePaths(); const db = openUsageDatabase(paths.database);
  try { await consumeClaudeHook(input, new UsageRepository(db), (error) => appendFileSync(paths.errors, `${new Date().toISOString()} ${String(error)}\n`)); }
  finally { db.close(); }
});
```

- [ ] **Step 4: Verify no telemetry error reaches hook stdout or exit status**

Run: `npm test -- tests/adapters/claude/hook-command.test.ts tests/cli.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the hook command**

```bash
git add src/adapters/claude/hook-command.ts src/cli.ts tests/adapters/claude/hook-command.test.ts tests/cli.test.ts
git commit -m "feat: add fail-open claude hook command"
```

### Task 4: Generate the Personal Claude Plugin and `/usage-stats` Alias

**Files:**
- Create: `src/adapters/claude/plugin-files.ts`
- Create: `tests/adapters/claude/plugin-files.test.ts`

- [ ] **Step 1: Write failing deterministic-template tests**

```ts
// tests/adapters/claude/plugin-files.test.ts
import { expect, it } from 'vitest';
import { claudePluginFiles } from '../../../src/adapters/claude/plugin-files.js';

it('bundles hooks, MCP, runtime path, and a plain alias without absolute build paths', () => {
  const files = claudePluginFiles();
  expect(JSON.parse(files['hooks/hooks.json']).hooks.PostToolUse[0].matcher).toContain('mcp__');
  expect(files['.mcp.json']).toContain('${CLAUDE_PLUGIN_ROOT}/runtime/agent-usage.mjs');
  expect(files['skills/usage-stats/SKILL.md']).toContain('query_usage');
  expect(files['alias/SKILL.md']).toContain('name: usage-stats');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/claude/plugin-files.test.ts`

Expected: FAIL because templates do not exist.

- [ ] **Step 3: Implement exact plugin templates**

```ts
// src/adapters/claude/plugin-files.ts
export function claudePluginFiles(): Record<string, string> {
  const command = 'node "${CLAUDE_PLUGIN_ROOT}/runtime/agent-usage.mjs" hook claude';
  return {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'agent-usage', displayName: 'Agent Usage', version: '0.1.0', description: 'Local MCP and Skill usage statistics' }, null, 2),
    'hooks/hooks.json': JSON.stringify({ hooks: {
      UserPromptExpansion: [{ matcher: '.*', hooks: [{ type: 'command', command }] }],
      PostToolUse: [{ matcher: '^(Skill|mcp__.*)$', hooks: [{ type: 'command', command }] }],
      PostToolUseFailure: [{ matcher: '^(Skill|mcp__.*)$', hooks: [{ type: 'command', command }] }]
    } }, null, 2),
    '.mcp.json': JSON.stringify({ mcpServers: { 'usage-stats': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/runtime/agent-usage.mjs', 'mcp', '--agent', 'claude-code'] } } }, null, 2),
    'skills/usage-stats/SKILL.md': `---\nname: usage-stats\ndescription: Use when the user asks to inspect local Skill or MCP usage statistics.\n---\nCall the \`query_usage\` tool from the \`usage-stats\` MCP server using \`$ARGUMENTS\` as the range/filter. Render the returned structured data without querying raw files.`,
    'alias/SKILL.md': `---\nname: usage-stats\ndescription: Use when the user asks to inspect local Skill or MCP usage statistics.\n---\nCall the \`query_usage\` tool from the \`usage-stats\` MCP server using \`$ARGUMENTS\` as the range/filter.`
  };
}
```

- [ ] **Step 4: Verify templates and JSON parsing**

Run: `npm test -- tests/adapters/claude/plugin-files.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit plugin templates**

```bash
git add src/adapters/claude/plugin-files.ts tests/adapters/claude/plugin-files.test.ts
git commit -m "feat: define claude usage plugin"
```

### Task 5: Implement Idempotent Claude Install, Health, and Uninstall

**Files:**
- Create: `src/core/atomic-file.ts`
- Create: `src/adapters/claude/adapter.ts`
- Modify: `src/adapters/registry.ts`
- Create: `tests/adapters/claude/adapter.test.ts`

- [ ] **Step 1: Write failing lifecycle tests with a temporary HOME**

```ts
// tests/adapters/claude/adapter.test.ts
import { expect, it } from 'vitest';
import { createClaudeAdapter } from '../../../src/adapters/claude/adapter.js';

it('installs a skills-directory plugin and plain alias, then removes only owned files', async () => {
  const adapter = createClaudeAdapter({ home: '/tmp/fake-home', runtimeBundle: Buffer.from('runtime') });
  const result = await adapter.install('user');
  expect(result.every((entry) => entry.status === 'success')).toBe(true);
  expect(await adapter.health()).toMatchObject({ agent: 'claude-code', skills: 'exact', mcp: 'exact' });
  expect((await adapter.uninstall('user')).every((entry) => entry.status !== 'failed')).toBe(true);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/claude/adapter.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Add atomic owned-file writes**

```ts
// src/core/atomic-file.ts
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function atomicWrite(file: string, content: string | Uint8Array, mode = 0o644): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.agent-usage-${process.pid}`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, file);
}
```

- [ ] **Step 4: Implement the Claude adapter**

```ts
// src/adapters/claude/adapter.ts
import { join } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import { atomicWrite } from '../../core/atomic-file.js';
import { claudePluginFiles } from './plugin-files.js';
import type { AgentAdapter, OperationResult, Scope } from '../types.js';

export function createClaudeAdapter(options: { home: string; runtimeBundle: Uint8Array }): AgentAdapter {
  const root = join(options.home, '.claude', 'skills', 'agent-usage-plugin');
  const alias = join(options.home, '.claude', 'skills', 'usage-stats', 'SKILL.md');
  const files = claudePluginFiles();
  const install = async (_scope: Scope): Promise<OperationResult[]> => {
    for (const [relative, content] of Object.entries(files)) if (relative !== 'alias/SKILL.md') await atomicWrite(join(root, relative), content);
    await atomicWrite(join(root, 'runtime', 'agent-usage.mjs'), options.runtimeBundle, 0o755);
    await atomicWrite(alias, files['alias/SKILL.md']!);
    return [{ status: 'success', path: root, message: 'Claude plugin installed' }];
  };
  return {
    id: 'claude-code', capabilities: { nativeSkillEvents: true, skillInjection: false, nativeMcpEvents: true, stdioMcpProxy: false, skillWatching: false },
    discover: async () => [root], install, sync: install, repair: install,
    health: async () => { try { await readFile(join(root, 'hooks', 'hooks.json')); return { agent: 'claude-code', skills: 'exact', mcp: 'exact', issues: [] }; } catch { return { agent: 'claude-code', skills: 'unavailable', mcp: 'unavailable', issues: ['plugin missing'] }; } },
    uninstall: async () => { await rm(root, { recursive: true, force: true }); await rm(alias, { force: true }); return [{ status: 'success', path: root, message: 'Claude plugin removed' }]; }
  };
}
```

Before GREEN, add an ownership manifest containing SHA-256 hashes for every installed file. Uninstall must delete the alias only when its current hash matches the manifest; otherwise return `degraded` and preserve it. `health` additionally runs `claude plugin validate <root>` via `execFile` when Claude exists and includes policy/validation stderr in `issues`.

- [ ] **Step 5: Run lifecycle and plugin validation tests**

Run: `npm test -- tests/adapters/claude && npm run build && claude plugin validate ~/.claude/skills/agent-usage-plugin 2>/dev/null || true`

Expected: tests pass; validation passes after a real install and otherwise produces only the expected missing-path diagnostic.

- [ ] **Step 6: Commit the Claude lifecycle**

```bash
git add src/core/atomic-file.ts src/adapters/claude src/adapters/registry.ts tests/adapters/claude
git commit -m "feat: install claude usage plugin"
```

### Task 6: End-to-End Claude Code Verification

**Files:**
- Create: `tests/integration/claude-adapter.test.ts`
- Modify: `docs/superpowers/specs/2026-06-18-cross-agent-usage-stats-design.md` only if the real payload differs from the official fixture.

- [ ] **Step 1: Add a disposable-home integration test**

```ts
// tests/integration/claude-adapter.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('installs and records one Skill plus one MCP hook', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-adapter-'));
  const env = { ...process.env, HOME: home, AGENT_USAGE_HOME: join(home, '.agent-usage') };
  execFileSync(process.execPath, ['dist/agent-usage.mjs', 'install', 'claude-code'], { env });
  for (const name of ['model-skill-success', 'mcp-success']) {
    execFileSync(process.execPath, ['dist/agent-usage.mjs', 'hook', 'claude'], { env, input: readFileSync(`tests/fixtures/claude-hooks/${name}.json`) });
  }
  const output = execFileSync(process.execPath, ['dist/agent-usage.mjs', 'report', 'today'], { env, encoding: 'utf8' });
  expect(output).toContain('deploy');
  expect(output).toContain('github');
});
```

- [ ] **Step 2: Verify RED before wiring the built runtime into the installer fixture**

Run: `npm test -- tests/integration/claude-adapter.test.ts`

Expected: FAIL until the adapter copies `dist/agent-usage.mjs` into the plugin.

- [ ] **Step 3: Complete the runtime-copy path and rerun**

Use `readFile(new URL('../../../dist/agent-usage.mjs', import.meta.url))` in the production CLI install command and inject the bytes into `createClaudeAdapter`. Keep direct filesystem reads out of unit tests by retaining constructor injection.

- [ ] **Step 4: Run full Claude verification**

Run: `npm run build && npm test -- tests/adapters/claude tests/integration/claude-adapter.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the verified adapter**

```bash
git add tests/integration/claude-adapter.test.ts src/cli.ts src/adapters/claude
git commit -m "test: verify claude usage adapter"
```

## Claude Plan Completion Check

Run:

```bash
npm run build
npm test
npm run check
node dist/agent-usage.mjs install claude-code --scope user
node dist/agent-usage.mjs health claude-code
```

Expected: plugin and alias install successfully; health reports exact Skill and MCP coverage. Restart Claude Code, invoke one Skill and one MCP tool, then run `/usage-stats today` and verify both appear.
