# Selective Usage Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Skill and MCP telemetry explicitly opt-in per Agent, including independent `native_hook` and `injected_mcp` Skill modes.

**Architecture:** A versioned JSON policy in the shared usage home is the single source of truth. The CLI replaces one Agent's desired policy atomically, adapters discover and reconcile selected targets, and every event writer applies the same matcher as a defense-in-depth filter.

**Tech Stack:** TypeScript, Node.js 24 filesystem APIs, Zod, Commander, Vitest.

---

## File Map

- `src/core/selection.ts`: versioned policy schema, literal/`*` matching, mode resolution, and atomic persistence.
- `src/core/paths.ts`: shared `config.json` path.
- `src/adapters/types.ts`: discovered-target and selection-aware adapter contracts.
- `src/cli.ts`: `list-targets`, `configure`, and proxy filtering.
- `src/adapters/claude/adapter.ts`: Claude discovery, selective native/injected reconciliation, and deselection cleanup.
- `src/adapters/claude/hook-command.ts`: hook-side policy filter and injected-mode suppression.
- `src/adapters/joycode/adapter.ts`: JoyCode discovery and selection-aware reconciliation.
- `src/adapters/joycode/injector.ts`: selected-only managed-block changes.
- `src/adapters/joycode/mcp-config.ts`: selected-only stdio wrapping and deselection restoration.
- `tests/core/selection.test.ts`: policy parsing, matching, validation, and atomic updates.
- `tests/cli.test.ts`: selection commands and proxy enforcement.
- `tests/adapters/claude/selection.test.ts`: two Claude Skill modes and no double counting.
- `tests/adapters/joycode/selection.test.ts`: selected injection/proxy behavior and incremental reconciliation.

### Task 1: Add the Versioned Selection Policy

**Files:**
- Create: `src/core/selection.ts`
- Modify: `src/core/paths.ts`
- Create: `tests/core/selection.test.ts`

- [ ] **Step 1: Write failing matcher and empty-policy tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  emptyAgentSelection,
  matchSelectionPattern,
  selectedMcp,
  selectedSkillMode,
} from '../../src/core/selection.js';

describe('selection matching', () => {
  it('anchors case-sensitive literal and star patterns', () => {
    expect(matchSelectionPattern('release-*', 'release-prod')).toBe(true);
    expect(matchSelectionPattern('release-*', 'x-release-prod')).toBe(false);
    expect(matchSelectionPattern('Review', 'review')).toBe(false);
  });

  it('selects nothing from a fresh policy', () => {
    const policy = emptyAgentSelection();
    expect(selectedSkillMode(policy, 'review')).toBeUndefined();
    expect(selectedMcp(policy, 'github', 'search')).toBe(false);
  });

  it('matches an MCP server or its server.tool identifier', () => {
    const policy = { skills: { native_hook: [], injected_mcp: [] }, mcp: ['github', 'fs.read_*'] };
    expect(selectedMcp(policy, 'github', 'search')).toBe(true);
    expect(selectedMcp(policy, 'fs', 'read_file')).toBe(true);
    expect(selectedMcp(policy, 'fs', 'write_file')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/core/selection.test.ts`

Expected: FAIL because `src/core/selection.ts` does not exist.

- [ ] **Step 3: Implement the policy schema and matchers**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const skillModes = ['native_hook', 'injected_mcp'] as const;
export type SkillMode = typeof skillModes[number];

const agentSelectionSchema = z.object({
  skills: z.object({
    native_hook: z.array(z.string()),
    injected_mcp: z.array(z.string()),
  }),
  mcp: z.array(z.string()),
});
export type AgentSelectionPolicy = z.infer<typeof agentSelectionSchema>;

const selectionConfigSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), agentSelectionSchema),
});
export type SelectionConfig = z.infer<typeof selectionConfigSchema>;

export const emptyAgentSelection = (): AgentSelectionPolicy => ({
  skills: { native_hook: [], injected_mcp: [] },
  mcp: [],
});
export const emptySelectionConfig = (): SelectionConfig => ({ version: 1, agents: {} });

const regexp = (pattern: string) => new RegExp(`^${pattern.split('*').map(
  (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
).join('.*')}$`);
export const matchSelectionPattern = (pattern: string, value: string): boolean => regexp(pattern).test(value);

export function selectedSkillMode(policy: AgentSelectionPolicy, name: string): SkillMode | undefined {
  const native = policy.skills.native_hook.some((pattern) => matchSelectionPattern(pattern, name));
  const injected = policy.skills.injected_mcp.some((pattern) => matchSelectionPattern(pattern, name));
  if (native && injected) throw new Error(`Skill "${name}" matches both native_hook and injected_mcp`);
  return native ? 'native_hook' : injected ? 'injected_mcp' : undefined;
}

export function selectedMcp(policy: AgentSelectionPolicy, server: string, tool: string): boolean {
  return policy.mcp.some((pattern) =>
    matchSelectionPattern(pattern, server) || matchSelectionPattern(pattern, `${server}.${tool}`),
  );
}

export async function loadSelectionConfig(path: string): Promise<SelectionConfig> {
  try { return selectionConfigSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySelectionConfig();
    throw error;
  }
}

export async function saveSelectionConfig(path: string, config: SelectionConfig): Promise<void> {
  const parsed = selectionConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
```

- [ ] **Step 4: Add persistence, invalid JSON, duplicate-mode, and path tests**

The tests must verify a missing file returns `{version: 1, agents: {}}`, a written file round-trips, invalid content is rejected without overwriting the old file, and one concrete Skill cannot resolve to both modes. Add `config: join(root, 'config.json')` to `UsagePaths` and `usagePaths()`.

Run: `npm test -- tests/core/selection.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the policy core**

```bash
git add src/core/selection.ts src/core/paths.ts tests/core/selection.test.ts
git commit -m "feat: add selective collection policy"
```

### Task 2: Expose Target Discovery and Configuration

**Files:**
- Modify: `src/adapters/types.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Write failing adapter-routing tests**

```ts
it('lists discovered targets for one adapter', async () => {
  const adapter = fakeAdapter();
  adapter.listTargets.mockResolvedValue({
    agent: 'codex',
    skills: [{ name: 'review', scope: 'user', path: '/skills/review', supportedModes: ['native_hook'] }],
    mcp: [{ server: 'github', scope: 'user', transport: 'stdio' }],
    unresolved: [], issues: [],
  });
  const fixture = runtimeFixture();
  await parse(registryWith(adapter), fixture.runtime, ['list-targets', 'codex']);
  expect(fixture.stdout.join('')).toContain('review');
  expect(fixture.stdout.join('')).toContain('github');
});

it('replaces one agent policy from repeated configure options', async () => {
  const adapter = fakeAdapter();
  const fixture = runtimeFixture();
  await parse(registryWith(adapter), fixture.runtime, [
    'configure', 'codex', '--native-skill', 'review', '--inject-skill', 'deploy', '--mcp', 'github.*',
  ]);
  expect(adapter.configure).toHaveBeenCalledWith({
    skills: { native_hook: ['review'], injected_mcp: ['deploy'] }, mcp: ['github.*'],
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/cli.test.ts`

Expected: FAIL because the adapter methods and commands do not exist.

- [ ] **Step 3: Extend the adapter contract**

```ts
import type { AgentSelectionPolicy, SkillMode } from '../core/selection.js';

export interface DiscoveredSkill {
  name: string; scope: Scope; path: string; supportedModes: SkillMode[]; selectedMode?: SkillMode;
}
export interface DiscoveredMcp {
  server: string; scope: Scope; transport: string; selected?: boolean;
}
export interface DiscoveredTargets {
  agent: string; skills: DiscoveredSkill[]; mcp: DiscoveredMcp[]; unresolved: string[]; issues: string[];
}

// Add to AgentAdapter:
listTargets(): Promise<DiscoveredTargets>;
configure(policy: AgentSelectionPolicy): Promise<OperationResult[]>;
```

- [ ] **Step 4: Add `list-targets` and replacement-style `configure` commands**

Use Commander collectors for repeated `--native-skill`, `--inject-skill`, and `--mcp`. `--all-skills <native_hook|injected_mcp>` resolves to `*` in that explicit mode and `--all-mcp` stores `*`. Reject unsupported modes and any concrete discovered Skill matched by both modes before calling `configure`. Print the complete resulting desired policy and adapter reconciliation results.

Run: `npm test -- tests/cli.test.ts && npm run check`

Expected: PASS, including tests that omitted options clear the corresponding lists and invalid mode overlap does not mutate configuration.

- [ ] **Step 5: Commit the CLI contract**

```bash
git add src/adapters/types.ts src/cli.ts tests/cli.test.ts
git commit -m "feat: configure selected usage targets"
```

### Task 3: Enforce MCP Selection in the Proxy

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Write failing selected and unselected proxy tests**

Configure the runtime with a policy loader returning `mcp: ['github.search']`. Relay the same fake MCP child twice: `github.search` must insert one event and `github.write` must relay unchanged without inserting. Also verify a missing policy opens no database for telemetry.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/cli.test.ts -t "proxy selection"`

Expected: FAIL because proxy telemetry currently stores every observed call.

- [ ] **Step 3: Filter the observer's emit callback**

Load `config.json` before telemetry initialization, get `config.agents[agent] ?? emptyAgentSelection()`, and emit only when an `mcp_call` satisfies `selectedMcp(policy, event.mcpServer, event.name)`. Policy read errors are logged and produce no telemetry, while the child server still starts and all bytes still relay.

- [ ] **Step 4: Verify proxy behavior and regressions**

Run: `npm test -- tests/cli.test.ts tests/proxy && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit proxy enforcement**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: filter proxied mcp telemetry"
```

### Task 4: Reconcile Claude's Two Skill Modes

**Files:**
- Modify: `src/adapters/claude/adapter.ts`
- Modify: `src/adapters/claude/hook-command.ts`
- Create: `tests/adapters/claude/selection.test.ts`

- [ ] **Step 1: Write failing mode-selection tests**

Use two fixture Skills, `review` and `deploy`. Configure `review` as `native_hook` and `deploy` as `injected_mcp`. Assert only `deploy/SKILL.md` receives one managed accounting block, the hook stores `review`, the hook discards `deploy` and an unselected Skill, and repeated reconciliation is byte-identical.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/adapters/claude/selection.test.ts`

Expected: FAIL because selection-aware reconciliation is absent.

- [ ] **Step 3: Implement discovery and reconciliation**

`listTargets()` scans the supported user and project Skill roots plus configured MCP servers. `configure()` validates supported modes, persists the desired policy through the shared policy store, then reconciles managed blocks. For each discovered Skill, call `selectedSkillMode`: inject only `injected_mcp`, remove a prior managed block for `native_hook` or unselected, and leave all other bytes untouched.

- [ ] **Step 4: Filter hook events without double counting**

After normalizing a hook event, load the current Agent policy. Store Skill events only when `selectedSkillMode(policy, event.name) === 'native_hook'`. Store MCP events only when `selectedMcp(policy, event.mcpServer, event.name)`. A missing or unreadable policy is fail-open for Claude's action but fail-closed for telemetry.

- [ ] **Step 5: Verify Claude selection**

Run: `npm test -- tests/adapters/claude && npm run check`

Expected: PASS.

- [ ] **Step 6: Commit Claude selection**

```bash
git add src/adapters/claude tests/adapters/claude
git commit -m "feat: select claude skill evidence modes"
```

### Task 5: Reconcile JoyCode Selection and Incremental Skills

**Files:**
- Modify: `src/adapters/joycode/adapter.ts`
- Modify: `src/adapters/joycode/injector.ts`
- Modify: `src/adapters/joycode/mcp-config.ts`
- Create: `tests/adapters/joycode/selection.test.ts`

- [ ] **Step 1: Write failing selection and deselection tests**

Use fixture Skills `deploy`, `release-prod`, and `review`, plus stdio servers `github` and `filesystem` and one HTTP server. Select `deploy`/`release-*` and `github`. Assert only the two matching Skills receive managed blocks, only `github` is wrapped, and the HTTP server is reported unsupported rather than edited.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/adapters/joycode/selection.test.ts`

Expected: FAIL because JoyCode currently has no selection-aware reconciliation.

- [ ] **Step 3: Implement selected reconciliation**

`configure()` rejects `native_hook`, saves the desired policy, and runs `sync`. Each sync pass injects matching Skills, removes managed blocks from deselected Skills, wraps matching stdio MCP entries, and restores the original command/arguments for deselected entries using the installation manifest. Never wrap `usage-stats` itself.

- [ ] **Step 4: Test incremental discovery**

Create `release-staging/SKILL.md` after initial configuration and trigger the debounced watcher/reconciler. Assert it receives exactly one block. Create `notes/SKILL.md` and assert it stays byte-identical. Change the policy to empty and assert all managed blocks and proxy wrappers are removed.

- [ ] **Step 5: Verify JoyCode selection**

Run: `npm test -- tests/adapters/joycode && npm run check`

Expected: PASS.

- [ ] **Step 6: Commit JoyCode selection**

```bash
git add src/adapters/joycode tests/adapters/joycode
git commit -m "feat: select joycode usage targets"
```

### Task 6: Validate Selection End to End

**Files:**
- Create: `tests/e2e/selection.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add an automated end-to-end fixture**

Install into isolated fake Claude and JoyCode homes, configure non-overlapping targets, invoke hook/MCP fixtures, add one incremental Skill, query the database, and assert counts exist only for selected targets with `native_hook`, `injected_mcp`, and `mcp_proxy` evidence labels.

- [ ] **Step 2: Run all automated verification**

Run: `npm test && npm run check && npm run build`

Expected: all commands exit 0 with no warnings.

- [ ] **Step 3: Run real Claude Code validation**

Back up every touched real file. Select one existing Skill for `native_hook` and a different existing Skill for `injected_mcp`; invoke both through `claude -p`, query `usage.db`, verify exactly one event with the expected evidence per Skill, then remove the test policy and managed block. Preserve a redacted command/output transcript under `docs/validation/`.

- [ ] **Step 4: Document opt-in usage**

Document that installation alone records nothing, show `list-targets`, show individual `configure` examples for both Skill modes and MCP patterns, and explain that repeating `configure` replaces the Agent's prior desired policy.

- [ ] **Step 5: Commit validation and documentation**

```bash
git add tests/e2e/selection.test.ts README.md docs/validation
git commit -m "test: validate selective usage collection"
```
