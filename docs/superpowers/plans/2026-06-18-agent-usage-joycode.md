# JoyCode Usage Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add best-effort JoyCode Skill session-load telemetry and exact stdio MCP telemetry with incremental Skill instrumentation.

**Architecture:** The JoyCode adapter registers the accounting MCP server, injects a versioned accounting block into user and current-project Skills, watches for incremental changes while the MCP process is alive, and rewrites stdio MCP entries through the shared transparent proxy. All mutations are recorded and reversible.

**Tech Stack:** Existing TypeScript runtime, JoyCode JSON configuration, YAML 2.9, Chokidar 5, core MCP server, core stdio proxy, Vitest.

---

## File Map

- `src/adapters/joycode/paths.ts`: verified user/project JoyCode paths.
- `src/adapters/joycode/skill-file.ts`: frontmatter parsing and managed-block injection/removal.
- `src/adapters/joycode/skill-state.ts`: versioned instrumentation manifest.
- `src/adapters/joycode/reconciler.ts`: initial scan and incremental watcher.
- `src/adapters/joycode/mcp-config.ts`: accounting server registration and stdio wrapping.
- `src/adapters/joycode/prompt-config.ts`: `/usage-stats` prompt entry.
- `src/adapters/joycode/adapter.ts`: lifecycle orchestration and coverage.
- `tests/adapters/joycode/**`: fixtures and contract tests.

### Task 1: Add JoyCode Path Discovery

**Files:**
- Create: `src/adapters/joycode/paths.ts`
- Create: `tests/adapters/joycode/paths.test.ts`

- [ ] **Step 1: Write failing path tests from the verified adapter reference**

```ts
// tests/adapters/joycode/paths.test.ts
import { expect, it } from 'vitest';
import { joyCodePaths } from '../../../src/adapters/joycode/paths.js';

it('maps verified JoyCode user and project paths', () => {
  expect(joyCodePaths('/Users/me', '/work/app')).toEqual({
    userMcp: '/Users/me/.joycode/joycode-mcp.json',
    projectMcp: '/work/app/.joycode/mcp.json',
    userSkills: '/Users/me/.joycode/skills',
    projectSkills: '/work/app/.joycode/skills',
    userPrompts: '/Users/me/.joycode/prompt.json',
    projectPrompts: '/work/app/.joycode/prompt.json'
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/joycode/paths.test.ts`

Expected: FAIL because the path module does not exist.

- [ ] **Step 3: Implement path composition without environment reads**

```ts
// src/adapters/joycode/paths.ts
import { join } from 'node:path';
export function joyCodePaths(home: string, cwd: string) {
  return {
    userMcp: join(home, '.joycode', 'joycode-mcp.json'),
    projectMcp: join(cwd, '.joycode', 'mcp.json'),
    userSkills: join(home, '.joycode', 'skills'),
    projectSkills: join(cwd, '.joycode', 'skills'),
    userPrompts: join(home, '.joycode', 'prompt.json'),
    projectPrompts: join(cwd, '.joycode', 'prompt.json')
  };
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- tests/adapters/joycode/paths.test.ts && npm run check`

Expected: PASS.

```bash
git add src/adapters/joycode/paths.ts tests/adapters/joycode/paths.test.ts
git commit -m "feat: discover joycode configuration paths"
```

### Task 2: Inject and Remove a Versioned Skill Accounting Block

**Files:**
- Create: `src/adapters/joycode/skill-file.ts`
- Create: `tests/adapters/joycode/skill-file.test.ts`

- [ ] **Step 1: Write failing frontmatter, idempotency, and removal tests**

```ts
// tests/adapters/joycode/skill-file.test.ts
import { describe, expect, it } from 'vitest';
import { injectAccountingBlock, removeAccountingBlock } from '../../../src/adapters/joycode/skill-file.js';

const original = '---\r\nname: deploy\r\ndescription: Deploy safely\r\n---\r\n\r\n# Deploy\r\nDo work.\r\n';
describe('JoyCode Skill instrumentation', () => {
  it('inserts after frontmatter, preserves CRLF, and is idempotent', () => {
    const once = injectAccountingBlock(original, 'joycode:user:abc');
    const twice = injectAccountingBlock(once.content, 'joycode:user:abc');
    expect(once.content.indexOf('agent-usage:begin')).toBeGreaterThan(once.content.indexOf('description:'));
    expect(once.content).toContain('\r\n');
    expect(twice.content).toBe(once.content);
    expect(twice.changed).toBe(false);
  });
  it('removes only the managed block', () => {
    expect(removeAccountingBlock(injectAccountingBlock(original, 'joycode:user:abc').content).content).toBe(original);
  });
});
```

- [ ] **Step 2: Add dependency and verify RED**

Run: `npm install yaml@^2.9.0 chokidar@^5.0.0 && npm test -- tests/adapters/joycode/skill-file.test.ts`

Expected: FAIL because the injector does not exist.

- [ ] **Step 3: Implement exact marker and insertion rules**

```ts
// src/adapters/joycode/skill-file.ts
const BEGIN = '<!-- agent-usage:begin v1 -->';
const END = '<!-- agent-usage:end -->';
const block = (skillId: string, nl: string) => [BEGIN,
  '**Usage accounting:** When this skill is first activated in the current agent session, call the `record_skill` tool from the `usage-stats` MCP server exactly once with',
  `\`{"skill_id":"${skillId}"}\`. After any successful response, continue with the instructions below and do not call the accounting tool again in this session.`,
  'Do not call it when merely listing, inspecting, editing, or validating this Skill. If the tool is unavailable, continue without retrying.',
  END, ''].join(nl);

export function removeAccountingBlock(content: string): { content: string; changed: boolean } {
  const start = content.indexOf(BEGIN); if (start < 0) return { content, changed: false };
  const end = content.indexOf(END, start); if (end < 0) throw new Error('Malformed agent-usage block');
  const after = end + END.length; const suffix = content.slice(after).replace(/^(\r?\n){1,2}/, '');
  return { content: content.slice(0, start) + suffix, changed: true };
}

export function injectAccountingBlock(content: string, skillId: string): { content: string; changed: boolean } {
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  const clean = removeAccountingBlock(content).content;
  const bom = clean.startsWith('\uFEFF') ? '\uFEFF' : ''; const body = clean.slice(bom.length);
  const match = body.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const offset = match?.[0].length ?? 0;
  const next = `${bom}${body.slice(0, offset)}${offset ? nl : ''}${block(skillId, nl)}${body.slice(offset)}`;
  return { content: next, changed: next !== content };
}
```

- [ ] **Step 4: Add malformed frontmatter, BOM, no-frontmatter, existing-v0 marker, and non-ASCII fixtures**

```ts
it.each([
  ['no frontmatter', '# Deploy\n', '# Deploy'],
  ['BOM', '\uFEFF---\nname: 部署\n---\n正文\n', '\uFEFF---'],
  ['non-ASCII', '---\nname: 发布\n---\n执行。\n', '执行。']
])('handles %s', (_label, input, preserved) => {
  const output = injectAccountingBlock(input, 'joycode:user:abc').content;
  expect(output).toContain('agent-usage:begin v1');
  expect(output).toContain(preserved);
});
it('rejects an unterminated managed block', () => {
  expect(() => injectAccountingBlock('<!-- agent-usage:begin v1 -->\nbroken', 'id')).toThrow('Malformed');
});
```

Add an explicit v0 fixture and assert it is replaced by one v1 block. A malformed YAML frontmatter fixture belongs in the reconciler test and must produce `degraded` without a write.

- [ ] **Step 5: Verify and commit injection**

Run: `npm test -- tests/adapters/joycode/skill-file.test.ts && npm run check`

Expected: PASS.

```bash
git add package.json package-lock.json src/adapters/joycode/skill-file.ts tests/adapters/joycode/skill-file.test.ts
git commit -m "feat: instrument joycode skill files"
```

### Task 3: Reconcile Existing Skills and Track Managed State

**Files:**
- Create: `src/adapters/joycode/skill-state.ts`
- Create: `src/adapters/joycode/reconciler.ts`
- Create: `tests/adapters/joycode/reconciler.test.ts`

- [ ] **Step 1: Write failing reconciliation tests**

```ts
// tests/adapters/joycode/reconciler.test.ts
import { expect, it } from 'vitest';
import { JoyCodeSkillReconciler } from '../../../src/adapters/joycode/reconciler.js';

it('instruments user and project Skills but refuses escaping symlinks', async () => {
  const reconciler = new JoyCodeSkillReconciler({ roots: [
    { path: '/tmp/home/.joycode/skills', scope: 'user' },
    { path: '/tmp/project/.joycode/skills', scope: 'project' }
  ], stateFile: '/tmp/state.json' });
  const result = await reconciler.sync();
  expect(result.instrumented).toContain('deploy');
  expect(result.degraded).toContainEqual(expect.objectContaining({ reason: 'symlink-outside-root' }));
});
```

- [ ] **Step 2: Verify RED using a real temporary directory fixture**

Run: `npm test -- tests/adapters/joycode/reconciler.test.ts`

Expected: FAIL because the reconciler does not exist.

- [ ] **Step 3: Define the versioned state manifest**

```ts
// src/adapters/joycode/skill-state.ts
export interface InstrumentedSkillState {
  canonicalPath: string; skillId: string; scope: 'user' | 'project';
  injectionVersion: 1; beforeHash: string; afterHash: string; lastSeenAt: string;
}
export interface JoyCodeSkillManifest { version: 1; skills: Record<string, InstrumentedSkillState> }
export const emptyJoyCodeManifest = (): JoyCodeSkillManifest => ({ version: 1, skills: {} });
```

- [ ] **Step 4: Implement reconciliation with safe filesystem boundaries**

```ts
// src/adapters/joycode/reconciler.ts
import { glob, readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { stableSkillId } from '../../core/identity.js';
import { atomicWrite } from '../../core/atomic-file.js';
import { injectAccountingBlock } from './skill-file.js';

export class JoyCodeSkillReconciler {
  constructor(private readonly options: { roots: Array<{ path: string; scope: 'user' | 'project' }>; stateFile: string }) {}
  async sync() {
    const result = { instrumented: [] as string[], unchanged: [] as string[], degraded: [] as Array<{ path: string; reason: string }> };
    for (const root of this.options.roots) {
      let realRoot: string; try { realRoot = await realpath(root.path); } catch { continue; }
      for await (const file of glob(`${root.path}/*/SKILL.md`)) {
        try {
          const canonical = await realpath(file); const rel = relative(realRoot, canonical);
          if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(canonical) === resolve(realRoot)) { result.degraded.push({ path: file, reason: 'symlink-outside-root' }); continue; }
          const original = await readFile(canonical, 'utf8');
          const frontmatter = original.match(/^---\r?\n([\s\S]*?)\r?\n---/); if (frontmatter) YAML.parse(frontmatter[1]!);
          const id = stableSkillId('joycode', root.scope, canonical); const next = injectAccountingBlock(original, id);
          if (!next.changed) { result.unchanged.push(canonical); continue; }
          const mode = (await stat(canonical)).mode; await atomicWrite(canonical, next.content, mode); result.instrumented.push(canonical);
        } catch (error) { result.degraded.push({ path: file, reason: String(error) }); }
      }
    }
    await this.writeManifest(result);
    return result;
  }
}
```

Implement `writeManifest` with SHA-256 before/after hashes and `atomicWrite`. Tests inject roots and temporary files; production constructs user and project roots from `joyCodePaths`.

- [ ] **Step 5: Verify read-only, deleted, externally updated, and same-name cases**

Run: `npm test -- tests/adapters/joycode/reconciler.test.ts && npm run check`

Expected: PASS; external body changes survive reinjection and same-name Skills have different IDs.

- [ ] **Step 6: Commit reconciliation**

```bash
git add src/adapters/joycode/skill-state.ts src/adapters/joycode/reconciler.ts tests/adapters/joycode/reconciler.test.ts
git commit -m "feat: reconcile joycode skill instrumentation"
```

### Task 4: Watch Incremental Skill Changes During the MCP Session

**Files:**
- Modify: `src/adapters/joycode/reconciler.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/adapters/joycode/watcher.test.ts`

- [ ] **Step 1: Write a failing watcher test with fake timers**

```ts
// tests/adapters/joycode/watcher.test.ts
import { expect, it, vi } from 'vitest';
import { JoyCodeSkillReconciler } from '../../../src/adapters/joycode/reconciler.js';

it('debounces a newly created SKILL.md and closes with the MCP session', async () => {
  vi.useFakeTimers();
  const reconciler = new JoyCodeSkillReconciler(fixtureOptions());
  const handle = await reconciler.watch();
  await createFixtureSkill('new-skill');
  await vi.advanceTimersByTimeAsync(250);
  expect(await readFixtureSkill('new-skill')).toContain('agent-usage:begin v1');
  await handle.close();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/joycode/watcher.test.ts`

Expected: FAIL because `watch()` does not exist.

- [ ] **Step 3: Implement Chokidar watching with one debounced sync loop**

```ts
async watch(): Promise<{ close(): Promise<void> }> {
  await this.sync();
  let timer: NodeJS.Timeout | undefined;
  const watcher = chokidar.watch(this.roots.map((root) => join(root, '*', 'SKILL.md')), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 } });
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void this.sync(), 200); };
  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
  return { close: async () => { if (timer) clearTimeout(timer); await watcher.close(); } };
}
```

- [ ] **Step 4: Start reconciliation before JoyCode MCP transport connects**

```ts
export interface McpLifecycle { start(): Promise<void>; close(): Promise<void> }
export async function runUsageMcpServer(service: UsageMcpService, lifecycle?: McpLifecycle): Promise<void> {
  await lifecycle?.start();
  const server = buildUsageMcpServer(service);
  const close = async () => { await server.close(); await lifecycle?.close(); };
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
  await server.connect(new StdioServerTransport());
}
```

The JoyCode CLI branch supplies `{ start: async () => { watcher = await reconciler.watch(); }, close: async () => watcher?.close() }`. Other agents omit the lifecycle.

- [ ] **Step 5: Verify incremental behavior and teardown**

Run: `npm test -- tests/adapters/joycode/reconciler.test.ts tests/adapters/joycode/watcher.test.ts tests/mcp && npm run check`

Expected: PASS with no open-handle warning.

- [ ] **Step 6: Commit the watcher**

```bash
git add src/adapters/joycode/reconciler.ts src/mcp/server.ts tests/adapters/joycode/watcher.test.ts
git commit -m "feat: watch incremental joycode skills"
```

### Task 5: Register Accounting MCP and Wrap stdio Servers Reversibly

**Files:**
- Create: `src/adapters/joycode/mcp-config.ts`
- Create: `tests/adapters/joycode/mcp-config.test.ts`

- [ ] **Step 1: Write failing merge, wrapping, and restoration tests**

```ts
// tests/adapters/joycode/mcp-config.test.ts
import { expect, it } from 'vitest';
import { instrumentJoyCodeMcpConfig, restoreJoyCodeMcpConfig } from '../../../src/adapters/joycode/mcp-config.js';

it('preserves siblings, skips usage-stats, and wraps each stdio command once', () => {
  const original = { unrelated: true, mcpServers: {
    github: { command: 'npx', args: ['-y', '@example/github'], env: { TOKEN: 'kept' } },
    remote: { url: 'https://example.test/mcp' }
  } };
  const result = instrumentJoyCodeMcpConfig(original, '/runtime/agent-usage.mjs');
  expect(result.config.unrelated).toBe(true);
  expect(result.config.mcpServers.github.command).toBe(process.execPath);
  expect(result.config.mcpServers.github.args).toContain('proxy');
  expect(result.config.mcpServers.github.env.TOKEN).toBe('kept');
  expect(result.config.mcpServers.remote).toEqual(original.mcpServers.remote);
  expect(instrumentJoyCodeMcpConfig(result.config, '/runtime/agent-usage.mjs').config).toEqual(result.config);
  expect(restoreJoyCodeMcpConfig(result.config, result.manifest)).toEqual(original);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/joycode/mcp-config.test.ts`

Expected: FAIL because MCP mutation helpers do not exist.

- [ ] **Step 3: Implement explicit managed entries**

```ts
const accountingEntry = (runtime: string) => ({ command: process.execPath, args: [runtime, 'mcp', '--agent', 'joycode'] });
const wrappedEntry = (name: string, entry: { command: string; args?: string[] }, runtime: string) => ({
  ...entry,
  command: process.execPath,
  args: [runtime, 'proxy', '--agent', 'joycode', '--server', name, '--', entry.command, ...(entry.args ?? [])]
});
```

`instrumentJoyCodeMcpConfig` adds `mcpServers['usage-stats']`, wraps only entries containing a string `command`, skips remote URL entries, and stores the exact original entry plus a hash of the managed replacement in the manifest. `restoreJoyCodeMcpConfig` restores only when the current hash still matches; otherwise return a conflict without overwriting user edits.

```ts
export function instrumentJoyCodeMcpConfig(input: any, runtime: string) {
  const config = structuredClone(input); config.mcpServers ??= {}; const originals: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries<any>(config.mcpServers)) {
    const alreadyWrapped = entry?.command === process.execPath && entry?.args?.[0] === runtime && entry?.args?.[1] === 'proxy';
    if (name === 'usage-stats' || typeof entry?.command !== 'string' || alreadyWrapped) continue;
    originals[name] = structuredClone(entry); config.mcpServers[name] = wrappedEntry(name, entry, runtime);
  }
  config.mcpServers['usage-stats'] = accountingEntry(runtime);
  return { config, manifest: { version: 1, originals, managedHashes: Object.fromEntries(Object.keys(originals).map((name) => [name, hash(config.mcpServers[name])])) } };
}
export function restoreJoyCodeMcpConfig(input: any, manifest: any) {
  const config = structuredClone(input);
  for (const [name, original] of Object.entries(manifest.originals)) {
    if (hash(config.mcpServers?.[name]) !== manifest.managedHashes[name]) throw new Error(`Managed MCP entry changed: ${name}`);
    config.mcpServers[name] = original;
  }
  if (config.mcpServers?.['usage-stats']) delete config.mcpServers['usage-stats'];
  return config;
}
```

- [ ] **Step 4: Cover malformed JSON, missing `mcpServers`, changed managed entries, and remote entries**

Add exact test fixtures proving malformed JSON is not overwritten, a missing map is created, changed wrapped entries produce `degraded`, and HTTP/SSE entries remain untouched with a `stdio-only` coverage warning.

- [ ] **Step 5: Verify and commit MCP mutation**

Run: `npm test -- tests/adapters/joycode/mcp-config.test.ts tests/proxy && npm run check`

Expected: PASS.

```bash
git add src/adapters/joycode/mcp-config.ts tests/adapters/joycode/mcp-config.test.ts
git commit -m "feat: proxy joycode stdio mcp servers"
```

### Task 6: Install `/usage-stats` and Complete the JoyCode Adapter

**Files:**
- Create: `src/adapters/joycode/prompt-config.ts`
- Create: `src/adapters/joycode/adapter.ts`
- Modify: `src/adapters/registry.ts`
- Modify: `src/cli.ts`
- Create: `tests/adapters/joycode/adapter.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
// tests/adapters/joycode/adapter.test.ts
import { expect, it } from 'vitest';
import { createJoyCodeAdapter } from '../../../src/adapters/joycode/adapter.js';

it('installs, synchronizes, reports coverage, and uninstalls without touching siblings', async () => {
  const adapter = createJoyCodeAdapter(fixtureEnvironment());
  expect((await adapter.install('user')).every((result) => result.status !== 'failed')).toBe(true);
  expect(await adapter.health()).toMatchObject({ agent: 'joycode', skills: 'best-effort', mcp: 'exact (stdio-only)' });
  expect((await adapter.sync('user')).every((result) => result.status !== 'failed')).toBe(true);
  expect((await adapter.uninstall('user')).every((result) => result.status !== 'failed')).toBe(true);
  expect(await readSiblingPrompt()).toEqual({ name: 'other' });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/adapters/joycode/adapter.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement prompt and Skill templates**

```ts
// src/adapters/joycode/prompt-config.ts
export const usagePrompt = {
  label: 'usage-stats', name: 'usageStats', source: 'user',
  description: 'Show local MCP and Skill usage statistics',
  prompt: 'Call the `query_usage` tool from the `usage-stats` MCP server using the command arguments as filters, then render the structured result.'
};
export const usageSkill = `---\nname: usage-stats\ndescription: Use when the user asks to inspect local MCP or Skill usage statistics.\n---\nCall the \`query_usage\` tool from the \`usage-stats\` MCP server using \`$ARGUMENTS\` as filters and render the structured result.`;
```

- [ ] **Step 4: Implement adapter lifecycle composition**

```ts
// src/adapters/joycode/adapter.ts
export function createJoyCodeAdapter(environment: JoyCodeEnvironment): AgentAdapter {
  const paths = joyCodePaths(environment.home, environment.cwd);
  const reconcile = () => new JoyCodeSkillReconciler({ roots: [
    { path: paths.userSkills, scope: 'user' }, { path: paths.projectSkills, scope: 'project' }
  ], stateFile: join(environment.usageHome, 'state', 'joycode-skills.json') }).sync();
  const install = async (): Promise<OperationResult[]> => {
    await atomicWrite(environment.runtimePath, environment.runtimeBundle, 0o755);
    await mergeMcpFile(paths.userMcp, environment.runtimePath);
    await mergePromptFile(paths.userPrompts, usagePrompt);
    await atomicWrite(join(paths.userSkills, 'usage-stats', 'SKILL.md'), usageSkill);
    const synced = await reconcile();
    return [{ status: synced.degraded.length ? 'degraded' : 'success', message: `Instrumented ${synced.instrumented.length} JoyCode Skills` }];
  };
  return {
    id: 'joycode', capabilities: { nativeSkillEvents: false, skillInjection: true, nativeMcpEvents: false, stdioMcpProxy: true, skillWatching: true },
    discover: async () => [paths.userMcp, paths.userSkills], install: async () => install(), sync: async () => install(), repair: async () => install(),
    health: async () => inspectJoyCodeCoverage(paths, environment.usageHome),
    uninstall: async () => uninstallJoyCode(paths, environment.usageHome)
  };
}
```

`mergeMcpFile`, `mergePromptFile`, `inspectJoyCodeCoverage`, and `uninstallJoyCode` must use the tested pure mutation functions plus atomic file writes. Uninstall removes accounting blocks from every manifest entry and restores MCP entries only on managed-hash match.

- [ ] **Step 5: Register JoyCode and verify CLI lifecycle**

Run: `npm test -- tests/adapters/joycode && npm run check && npm run build`

Expected: PASS; `node dist/agent-usage.mjs health joycode` resolves the adapter.

- [ ] **Step 6: Commit the complete adapter**

```bash
git add src/adapters/joycode src/adapters/registry.ts src/cli.ts tests/adapters/joycode
git commit -m "feat: add joycode usage adapter"
```

### Task 7: End-to-End JoyCode Verification

**Files:**
- Create: `tests/integration/joycode-adapter.test.ts`
- Create: `tests/integration/joycode-proxy.test.ts`

- [ ] **Step 1: Add a disposable-home installation test**

```ts
it('installs idempotently in a disposable JoyCode home', () => {
  const fixture = createJoyCodeHome({ skills: ['deploy', 'review'], mcpServers: { fake: fakeServerEntry(), remote: { url: 'https://example.test/mcp' } } });
  runBuilt(['install', 'joycode'], fixture.env); runBuilt(['install', 'joycode'], fixture.env);
  expect(countMarker(fixture.skill('deploy'))).toBe(1);
  expect(readJson(fixture.userMcp).mcpServers.fake.args).toContain('proxy');
  expect(readJson(fixture.userMcp).mcpServers.remote.url).toBe('https://example.test/mcp');
  expect(readJson(fixture.prompts).filter((entry: any) => entry.label === 'usage-stats')).toHaveLength(1);
});
```

- [ ] **Step 2: Add a real-process proxy test**

```ts
it('records one proxied MCP call without arguments', async () => {
  const session = await startConfiguredFakeProxy();
  await session.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { token: 'secret' } } });
  await session.close();
  const rows = queryFixtureEvents();
  expect(rows).toMatchObject([{ evidence: 'mcp_proxy', outcome: 'success', name: 'search' }]);
  expect(JSON.stringify(rows)).not.toContain('secret');
});
```

- [ ] **Step 3: Add a live incremental Skill test**

```ts
it('injects a new Skill and deduplicates record_skill per connection', async () => {
  const client = await startUsageStatsMcp({ agent: 'joycode' });
  const file = await createSkillDuringSession('new-skill');
  await vi.waitFor(() => expect(readFileSync(file, 'utf8')).toContain('agent-usage:begin v1'));
  await client.callTool({ name: 'record_skill', arguments: { skill_id: 'joycode:user:new' } });
  await client.callTool({ name: 'record_skill', arguments: { skill_id: 'joycode:user:new' } });
  expect(queryFixtureEvents()).toHaveLength(1);
  await client.close();
});
```

- [ ] **Step 4: Run full JoyCode verification**

Run: `npm run build && npm test -- tests/adapters/joycode tests/integration/joycode-adapter.test.ts tests/integration/joycode-proxy.test.ts && npm run check`

Expected: PASS with no open handles or leaked child processes.

- [ ] **Step 5: Commit verified JoyCode support**

```bash
git add tests/integration/joycode-adapter.test.ts tests/integration/joycode-proxy.test.ts
git commit -m "test: verify joycode usage adapter"
```

## JoyCode Plan Completion Check

Run:

```bash
npm run build
npm test
npm run check
node dist/agent-usage.mjs install joycode --scope user
node dist/agent-usage.mjs health joycode
node dist/agent-usage.mjs sync joycode --scope user
```

Expected: installation is idempotent, health reports `best-effort` Skill and `exact (stdio-only)` MCP coverage, sync reports no pending mutations, and unrelated JoyCode configuration remains unchanged. Then validate one injected Skill and one proxied MCP tool in a real JoyCode session before release.
