import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { access, constants, readFile, rm, stat } from 'node:fs/promises';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  AgentAdapter,
  Capabilities,
  CoverageReport,
  DiscoveredMcp,
  DiscoveredSkill,
  DiscoveredTargets,
  OperationResult,
  Scope,
} from '../types.js';
import { atomicWrite } from '../../core/atomic-file.js';
import { stableSkillId } from '../../core/identity.js';
import {
  loadSelectionConfig,
  saveSelectionConfig,
  selectedMcp,
  selectedSkillMode,
  type AgentSelectionPolicy,
} from '../../core/selection.js';
import { hasManagedBlock, injectManagedBlock, removeManagedBlock } from './managed-block.js';
import { claudePluginFiles } from './plugin-files.js';

/** Agent id used by the Claude Code adapter. */
export const CLAUDE_ADAPTER_ID = 'claude-code';

/** Relative plugin path of the runtime bundle. */
const RUNTIME_RELATIVE = 'runtime/agent-usage.mjs';

/** Plugin directory name under <home>/.claude/skills. */
const PLUGIN_DIR_NAME = 'agent-usage-plugin';

/** Bare alias directory name under <home>/.claude/skills. */
const ALIAS_DIR_NAME = 'usage-stats';

/** Directories that are managed by the adapter and excluded from Skill discovery. */
const MANAGED_DIR_NAMES = new Set([PLUGIN_DIR_NAME, ALIAS_DIR_NAME]);

const CLAUDE_CAPABILITIES: Capabilities = {
  nativeSkillEvents: true,
  skillInjection: true,
  nativeMcpEvents: true,
  stdioMcpProxy: false,
  skillWatching: false,
};

/**
 * Dependencies injected into {@link createClaudeAdapter} so tests can target a
 * temporary HOME and a fake runtime bundle without touching the real
 * `~/.claude`.
 */
export interface ClaudeAdapterOptions {
  /** The user HOME: skills live under `<home>/.claude/skills`. */
  home: string;
  /** Absolute path to the selection policy (usagePaths().config). */
  selectionConfigPath: string;
  /** Bytes of the bundled runtime to copy into the plugin. */
  runtimeBundle: Uint8Array;
}

/**
 * Entry recorded in the ownership manifest for each file the installer writes.
 * `hash` is the SHA-256 of the canonical bytes written.
 */
interface OwnedFile {
  /** Absolute path of the owned file. */
  path: string;
  /** SHA-256 (hex) of the bytes the installer wrote. */
  hash: string;
}

/** On-disk layout of `.agent-usage-manifest.json` inside the plugin root. */
interface OwnershipManifest {
  version: 1;
  pluginRoot: string;
  files: OwnedFile[];
}

/** On-disk layout of `.agent-usage-injections.json` inside the plugin root. */
interface InjectionManifest {
  version: 1;
  /** Absolute paths of Skill files the adapter injected a managed block into. */
  skills: string[];
}

const MANIFEST_NAME = '.agent-usage-manifest.json';
const INJECTION_MANIFEST_NAME = '.agent-usage-injections.json';

function skillsRoot(home: string): string {
  return join(home, '.claude', 'skills');
}

function pluginRoot(home: string): string {
  return join(skillsRoot(home), PLUGIN_DIR_NAME);
}

function aliasPath(home: string): string {
  return join(skillsRoot(home), ALIAS_DIR_NAME, 'SKILL.md');
}

function manifestPath(home: string): string {
  return join(pluginRoot(home), MANIFEST_NAME);
}

function injectionManifestPath(home: string): string {
  return join(pluginRoot(home), INJECTION_MANIFEST_NAME);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function toBytes(content: string): Uint8Array {
  return Buffer.from(content, 'utf8');
}

function success(path: string, message: string): OperationResult {
  return { status: 'success', path, message };
}

function degraded(path: string, message: string): OperationResult {
  return { status: 'degraded', path, message };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isReadable(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Return true when the process can write to `path`. Used to honor read-only
 * Skill files: atomicWrite writes via a sibling temp file plus rename, which
 * would otherwise bypass the target's read-only mode.
 */
async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON manifest, returning `undefined` when it is absent or
 * malformed. Manifest corruption must never crash lifecycle operations.
 */
async function readManifest<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Discover the user Skills living under `<home>/.claude/skills`, excluding the
 * two directories managed by this adapter. Each entry is the absolute path of a
 * `SKILL.md` whose parent directory name is treated as the Skill name.
 */
function discoverUserSkills(home: string): Array<{ name: string; path: string }> {
  const root = skillsRoot(home);
  if (!isDirectory(root)) return [];
  const discovered: Array<{ name: string; path: string }> = [];
  for (const entry of readdirSync(root)) {
    if (MANAGED_DIR_NAMES.has(entry)) continue;
    const child = join(root, entry);
    if (!isDirectory(child)) continue;
    const skillFile = join(child, 'SKILL.md');
    if (isReadable(skillFile)) {
      discovered.push({ name: entry, path: skillFile });
    }
  }
  return discovered;
}

/**
 * Best-effort discovery of configured MCP servers from `<home>/.claude.json`.
 * Any read/parse problem yields an empty list; nothing here throws.
 */
async function discoverUserMcp(
  home: string,
  policy: AgentSelectionPolicy,
): Promise<DiscoveredMcp[]> {
  const configPath = join(home, '.claude.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const servers = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers;
  if (typeof servers !== 'object' || servers === null) return [];

  const discovered: DiscoveredMcp[] = [];
  for (const server of Object.keys(servers)) {
    const entry = (servers as Record<string, Record<string, unknown>>)[server];
    const transport = transportOf(entry);
    const record: DiscoveredMcp = {
      server,
      scope: 'user',
      transport,
      selected: selectedMcp(policy, server, ''),
    };
    discovered.push(record);
  }
  return discovered.sort((left, right) => left.server.localeCompare(right.server));
}

function transportOf(entry: Record<string, unknown> | undefined): DiscoveredMcp['transport'] {
  if (entry === undefined) return 'unknown';
  const declared = entry['type'];
  if (typeof declared === 'string') {
    if (declared === 'stdio') return 'stdio';
    if (declared === 'http') return 'http';
    if (declared === 'sse') return 'sse';
  }
  // A server with a `command` field is stdio by convention; otherwise unknown.
  if (typeof entry['command'] === 'string') return 'stdio';
  return 'unknown';
}

function resolveSkillSelection(
  policy: AgentSelectionPolicy,
  skill: { name: string; path: string },
): DiscoveredSkill {
  const supportedModes: DiscoveredSkill['supportedModes'] = ['native_hook', 'injected_mcp'];
  let selectedMode: DiscoveredSkill['selectedMode'];
  try {
    const mode = selectedSkillMode(policy, skill.name);
    selectedMode = mode;
  } catch {
    // A conflicting policy is reported via `issues` by the caller; here we
    // simply leave the Skill unselected rather than throwing.
    selectedMode = undefined;
  }
  const record: DiscoveredSkill = {
    name: skill.name,
    scope: 'user',
    path: skill.path,
    supportedModes,
    ...(selectedMode === undefined ? {} : { selectedMode }),
  };
  return record;
}

/**
 * Return the policy currently persisted for this agent, or an empty policy when
 * none is configured. Missing/corrupt files resolve to the empty policy.
 */
async function loadOwnPolicy(
  selectionConfigPath: string,
): Promise<AgentSelectionPolicy> {
  try {
    const config = await loadSelectionConfig(selectionConfigPath);
    return config.agents[CLAUDE_ADAPTER_ID] ?? emptyPolicy();
  } catch {
    return emptyPolicy();
  }
}

function emptyPolicy(): AgentSelectionPolicy {
  return { skills: { native_hook: [], injected_mcp: [] }, mcp: [] };
}

/**
 * Collect the patterns in `policy` that matched no discovered Skill or MCP.
 */
function unresolvedPatterns(
  policy: AgentSelectionPolicy,
  skills: DiscoveredSkill[],
  mcp: DiscoveredMcp[],
): string[] {
  const allPatterns = [
    ...policy.skills.native_hook,
    ...policy.skills.injected_mcp,
    ...policy.mcp,
  ];
  const matched = new Set<string>();
  const skillNames = skills.map((skill) => skill.name);
  const serverNames = mcp.map((server) => server.server);
  for (const pattern of allPatterns) {
    if (skillNames.some((name) => patternMatches(pattern, name))) {
      matched.add(pattern);
      continue;
    }
    if (serverNames.some((name) => patternMatches(pattern, name))) {
      matched.add(pattern);
    }
  }
  return [...new Set(allPatterns)].filter((pattern) => !matched.has(pattern)).sort();
}

function patternMatches(pattern: string, value: string): boolean {
  // Reuse the glob semantics from the selection module without re-importing
  // the matcher: split on `*` and require each literal segment in order.
  const segments = pattern.split('*');
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    if (index === 0) {
      if (!value.startsWith(segment)) return false;
      cursor = segment.length;
      continue;
    }
    const found = value.indexOf(segment, cursor);
    if (found === -1) return false;
    cursor = found + segment.length;
  }
  // For a trailing `*` (empty final segment) any suffix matches.
  return pattern.endsWith('*') || cursor === value.length;
}

/**
 * Build the Claude Code usage adapter. All filesystem state is rooted under the
 * injected `home`, so tests never touch the real `~/.claude`.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions): AgentAdapter {
  const { home, selectionConfigPath, runtimeBundle } = options;

  /**
   * Write every plugin file (except the alias), the runtime bundle, and the
   * alias. Refresh the ownership manifest with the hashes of the bytes written.
   * Idempotent.
   */
  async function reconcileInstall(scope: Scope): Promise<OperationResult[]> {
    const results: OperationResult[] = [];
    const root = pluginRoot(home);
    const files = claudePluginFiles();
    const owned: OwnedFile[] = [];

    for (const [relativePath, content] of Object.entries(files)) {
      if (relativePath === 'alias/SKILL.md') continue;
      const target = join(root, relativePath);
      const bytes = toBytes(content);
      try {
        await atomicWrite(target, bytes);
        owned.push({ path: target, hash: sha256(bytes) });
      } catch (error) {
        results.push(
          degraded(target, describeError('failed to write plugin file', error)),
        );
      }
    }

    // Runtime bundle, executable.
    const runtimeTarget = join(root, RUNTIME_RELATIVE);
    try {
      await atomicWrite(runtimeTarget, runtimeBundle, 0o755);
      owned.push({ path: runtimeTarget, hash: sha256(runtimeBundle) });
    } catch (error) {
      results.push(
        degraded(runtimeTarget, describeError('failed to write runtime', error)),
      );
    }

    // Bare alias.
    const alias = aliasPath(home);
    const aliasBytes = toBytes(files['alias/SKILL.md'] as string);
    try {
      await atomicWrite(alias, aliasBytes);
      owned.push({ path: alias, hash: sha256(aliasBytes) });
    } catch (error) {
      results.push(degraded(alias, describeError('failed to write alias', error)));
    }

    // Persist the ownership manifest.
    const manifest: OwnershipManifest = {
      version: 1,
      pluginRoot: root,
      files: owned,
    };
    const manifestFile = manifestPath(home);
    try {
      const manifestBytes = toBytes(`${JSON.stringify(manifest, null, 2)}\n`);
      await atomicWrite(manifestFile, manifestBytes);
    } catch (error) {
      results.push(
        degraded(manifestFile, describeError('failed to write manifest', error)),
      );
    }

    if (results.length === 0) {
      results.push(
        success(root, `installed claude-code plugin (${scope})`),
      );
    }
    return results;
  }

  /**
   * Reconcile managed blocks against the currently discovered Skills for the
   * given policy. Inject into `injected_mcp` skills, remove from everything
   * else. Tracks injected skill paths in the injection manifest so uninstall
   * can clean them up later.
   */
  async function reconcileBlocks(
    policy: AgentSelectionPolicy,
  ): Promise<{ results: OperationResult[]; injected: string[] }> {
    const results: OperationResult[] = [];
    const injected: string[] = [];
    const skills = discoverUserSkills(home);

    for (const skill of skills) {
      let mode: ReturnType<typeof selectedSkillMode>;
      try {
        mode = selectedSkillMode(policy, skill.name);
      } catch (error) {
        results.push(
          degraded(skill.path, describeError('conflicting selection', error)),
        );
        continue;
      }

      let nextContent: string;
      try {
        nextContent = await readFile(skill.path, 'utf8');
      } catch (error) {
        results.push(
          degraded(skill.path, describeError('unreadable skill file', error)),
        );
        continue;
      }

      const original = nextContent;

      if (mode === 'injected_mcp') {
        const skillId = stableSkillId(CLAUDE_ADAPTER_ID, 'user', skill.path);
        nextContent = injectManagedBlock(original, skillId);
      } else {
        // native_hook or unselected: ensure no managed block remains.
        nextContent = removeManagedBlock(original);
      }

      if (nextContent === original) {
        if (mode === 'injected_mcp') injected.push(skill.path);
        continue;
      }

      // Honor read-only Skill files: never overwrite a file we cannot write.
      if (!(await isWritable(skill.path))) {
        results.push(
          degraded(skill.path, 'skill file is read-only; block not reconciled'),
        );
        continue;
      }

      try {
        await atomicWrite(skill.path, toBytes(nextContent));
        if (mode === 'injected_mcp') injected.push(skill.path);
      } catch (error) {
        results.push(
          degraded(skill.path, describeError('failed to reconcile skill block', error)),
        );
      }
    }

    // Record the set of injected skills so uninstall can strip blocks later.
    const injectionFile = injectionManifestPath(home);
    try {
      const injectionManifest: InjectionManifest = {
        version: 1,
        skills: [...injected].sort(),
      };
      await atomicWrite(
        injectionFile,
        toBytes(`${JSON.stringify(injectionManifest, null, 2)}\n`),
      );
    } catch (error) {
      results.push(
        degraded(injectionFile, describeError('failed to write injection manifest', error)),
      );
    }

    return { results, injected };
  }

  async function adapterDiscover(): Promise<string[]> {
    if (existsSync(manifestPath(home))) return [pluginRoot(home)];
    return [];
  }

  async function adapterListTargets(): Promise<DiscoveredTargets> {
    const policy = await loadOwnPolicy(selectionConfigPath);
    const skills = discoverUserSkills(home).map((skill) =>
      resolveSkillSelection(policy, skill),
    );
    const mcp = await discoverUserMcp(home, policy);

    const issues: string[] = [];
    // Surface conflicting skill selections (selectedSkillMode throws).
    for (const skill of discoverUserSkills(home)) {
      try {
        selectedSkillMode(policy, skill.name);
      } catch {
        issues.push(
          `Skill "${skill.name}" matches both native_hook and injected_mcp`,
        );
      }
    }

    const unresolved = unresolvedPatterns(policy, skills, mcp);

    return {
      agent: CLAUDE_ADAPTER_ID,
      skills,
      mcp,
      unresolved,
      issues: [...issues].sort(),
    };
  }

  async function adapterConfigure(
    policy: AgentSelectionPolicy,
  ): Promise<OperationResult[]> {
    // (1) Persist the policy for this agent.
    let config;
    try {
      config = await loadSelectionConfig(selectionConfigPath);
    } catch {
      config = { version: 1 as const, agents: {} };
    }
    const nextConfig = {
      version: 1 as const,
      agents: { ...config.agents, [CLAUDE_ADAPTER_ID]: policy },
    };
    try {
      await saveSelectionConfig(selectionConfigPath, nextConfig);
    } catch (error) {
      return [
        degraded(
          selectionConfigPath,
          describeError('failed to persist selection policy', error),
        ),
      ];
    }

    // (2) Reconcile managed blocks against the discovered skills.
    const { results } = await reconcileBlocks(policy);
    if (results.length === 0) {
      return [
        success(
          selectionConfigPath,
          `configured claude-code selection policy`,
        ),
      ];
    }
    return results;
  }

  async function adapterInstall(scope: Scope): Promise<OperationResult[]> {
    return reconcileInstall(scope);
  }

  async function adapterSync(scope: Scope): Promise<OperationResult[]> {
    return reconcileInstall(scope);
  }

  async function adapterRepair(scope: Scope): Promise<OperationResult[]> {
    return reconcileInstall(scope);
  }

  async function adapterUninstall(scope: Scope): Promise<OperationResult[]> {
    const results: OperationResult[] = [];

    // (1) Strip managed blocks from previously injected skill files.
    const injectionManifest = await readManifest<InjectionManifest>(
      injectionManifestPath(home),
    );
    if (injectionManifest?.skills !== undefined) {
      for (const skillPath of injectionManifest.skills) {
        try {
          const content = await readFile(skillPath, 'utf8');
          const stripped = removeManagedBlock(content);
          if (stripped !== content) {
            await atomicWrite(skillPath, toBytes(stripped));
          }
        } catch (error) {
          results.push(
            degraded(skillPath, describeError('failed to remove managed block', error)),
          );
        }
      }
    }

    // (2) Remove owned files (hash match), preserve user-edited ones.
    const manifest = await readManifest<OwnershipManifest>(manifestPath(home));
    const preserved = new Set<string>();
    if (manifest?.files !== undefined) {
      for (const owned of manifest.files) {
        try {
          const info = await stat(owned.path);
          if (!info.isFile()) {
            results.push(degraded(owned.path, 'owned path is not a regular file'));
            preserved.add(owned.path);
            continue;
          }
          const currentHash = await sha256File(owned.path);
          if (currentHash !== owned.hash) {
            results.push(
              degraded(
                owned.path,
                'preserved user-edited file (hash mismatch with manifest)',
              ),
            );
            // Keep the user-edited file; pruneDirectory must leave the tree
            // intact while any preserved file remains.
            preserved.add(owned.path);
          } else {
            await rm(owned.path, { force: true });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          results.push(
            degraded(owned.path, describeError('failed to remove owned file', error)),
          );
          preserved.add(owned.path);
        }
      }
    }

    // (3) Remove the manifests themselves.
    for (const manifestFile of [manifestPath(home), injectionManifestPath(home)]) {
      try {
        await rm(manifestFile, { force: true });
      } catch (error) {
        results.push(
          degraded(manifestFile, describeError('failed to remove manifest', error)),
        );
      }
    }

    // (4) Remove the plugin root and alias directory trees. If any preserved
    // (user-edited) file remains inside, leave the tree intact and surface a
    // degraded result so the user can review it.
    const root = pluginRoot(home);
    results.push(...(await pruneDirectory(root, preserved)));
    results.push(...(await pruneDirectory(dirname(aliasPath(home)), preserved)));

    if (results.length === 0) {
      results.push(success(root, `uninstalled claude-code plugin (${scope})`));
    }
    return results;
  }

  async function adapterHealth(): Promise<CoverageReport> {
    const root = pluginRoot(home);
    const hooksPresent = existsSync(join(root, 'hooks', 'hooks.json'));
    const runtimePresent = existsSync(join(root, RUNTIME_RELATIVE));
    const installed = hooksPresent && runtimePresent;

    if (installed) {
      const issues: string[] = [];
      if (!existsSync(aliasPath(home))) {
        issues.push('usage-stats alias missing');
      }
      return {
        agent: CLAUDE_ADAPTER_ID,
        skills: 'native and injected',
        mcp: 'native',
        issues,
      };
    }

    return {
      agent: CLAUDE_ADAPTER_ID,
      skills: 'unavailable',
      mcp: 'unavailable',
      issues: ['plugin not installed'],
    };
  }

  return {
    id: CLAUDE_ADAPTER_ID,
    capabilities: CLAUDE_CAPABILITIES,
    discover: adapterDiscover,
    listTargets: adapterListTargets,
    configure: adapterConfigure,
    install: adapterInstall,
    sync: adapterSync,
    repair: adapterRepair,
    uninstall: adapterUninstall,
    health: adapterHealth,
  };
}

/**
 * Recursively remove `directory` when it contains no regular files outside the
 * `preserved` set (which are user-edited files we must not delete). When a
 * non-owned file remains, leave the whole tree intact and surface a degraded
 * result so the user can review it. Only-empty directory trees (left after the
 * owned-file pass) are removed wholesale.
 */
async function pruneDirectory(
  directory: string,
  preserved: Set<string>,
): Promise<OperationResult[]> {
  if (!existsSync(directory)) return [];

  const remaining: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory()) {
          walk(child);
        } else {
          remaining.push(child);
        }
      } catch {
        // Unreadable entry; treat as a file we must preserve conservatively.
        remaining.push(child);
      }
    }
  };
  walk(directory);

  if (remaining.length > 0) {
    // Any remaining file (preserved user edit, non-owned file, or an owned file
    // that could not be removed) means we must NOT recursively delete the tree,
    // because that would also destroy the files we are obliged to preserve.
    const leftover = remaining.filter((path) => !preserved.has(path));
    const reason =
      leftover.length > 0
        ? `${leftover.length} non-owned file(s) remain`
        : `${remaining.length} user-edited file(s) preserved`;
    return [degraded(directory, `left in place: ${reason}`)];
  }

  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    return [degraded(directory, describeError('failed to remove directory', error))];
  }
  return [];
}

function describeError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Read the real runtime bundle from the build output. Used by the default CLI
 * registry so the production adapter ships the bundled `agent-usage.mjs`.
 *
 * When the CLI runs from source (`src/cli.ts`), the bundle lives three levels
 * above this module at `<root>/dist/agent-usage.mjs`. When the bundled runtime
 * is itself the entrypoint (`dist/agent-usage.mjs`), it reads its own bytes.
 */
export async function readRuntimeBundle(): Promise<Uint8Array> {
  const candidates = [
    new URL('../../../dist/agent-usage.mjs', import.meta.url),
    new URL('agent-usage.mjs', import.meta.url),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return readFile(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Build the default Claude Code adapter against the real user HOME and the
 * real selection-config path. Returns `undefined` when the runtime bundle
 * cannot be read (e.g. running from source before a build), so callers can
 * skip registration gracefully.
 */
export async function defaultClaudeAdapter(): Promise<AgentAdapter | undefined> {
  let runtimeBundle: Uint8Array;
  try {
    runtimeBundle = await readRuntimeBundle();
  } catch {
    return undefined;
  }
  return createClaudeAdapter({
    home: homedir(),
    selectionConfigPath: selectionConfigPathForHome(homedir()),
    runtimeBundle,
  });
}

function selectionConfigPathForHome(home: string): string {
  return join(home, '.agent-usage', 'config.json');
}
