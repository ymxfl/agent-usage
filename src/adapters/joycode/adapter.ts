import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { access, readFile, realpath, rm, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import YAML from 'yaml';

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
import type { McpLifecycle } from '../../mcp/server.js';
import { usagePaths } from '../../core/paths.js';
import {
  loadSelectionConfig,
  saveSelectionConfig,
  selectedMcp,
  selectedSkillMode,
  type AgentSelectionPolicy,
  type SelectionConfig,
} from '../../core/selection.js';
import {
  injectAccountingBlock,
  MANAGED_BLOCK_VERSION,
  removeAccountingBlock,
} from './skill-file.js';
import {
  hashMcpEntry,
  instrumentJoyCodeMcpConfig,
  restoreJoyCodeMcpConfig,
  type JoyCodeMcpConfig,
  type JoyCodeMcpEntry,
  type JoyCodeMcpManifest,
} from './mcp-config.js';
import { JoyCodeSkillReconciler } from './reconciler.js';
import { joyCodePaths } from './paths.js';
import { USAGE_PROMPT_LABEL, usagePrompt, usageSkill } from './prompt-config.js';
import {
  type InstrumentedSkillState,
  type JoyCodeSkillManifest,
} from './skill-state.js';

/** Agent id used by the JoyCode adapter. */
export const JOYCODE_ADAPTER_ID = 'joycode';

/** Accounting MCP server name (must never be wrapped). */
const ACCOUNTING_SERVER = 'usage-stats';

/** Name of the usage-stats skill directory under the user skills root. */
const USAGE_SKILL_NAME = 'usage-stats';

/** File name of the runtime bundle copied under <home>/.joycode. */
const RUNTIME_FILE_NAME = 'agent-usage-runtime.mjs';

/** File names of the adapter manifests under usageStateDir. */
const SKILL_MANIFEST_FILE = 'joycode-skill-manifest.json';
const MCP_MANIFEST_FILE = 'joycode-mcp-manifest.json';
const OWNERSHIP_MANIFEST_FILE = 'joycode-ownership-manifest.json';

const CLAUDE_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const JOYCODE_CAPABILITIES: Capabilities = {
  nativeSkillEvents: false,
  skillInjection: true,
  nativeMcpEvents: false,
  stdioMcpProxy: true,
  skillWatching: true,
};

/**
 * Dependencies injected into {@link createJoyCodeAdapter} so tests can target a
 * temporary HOME/CWD and a fake runtime bundle without touching the real
 * `~/.joycode`. All filesystem state is rooted under the injected paths.
 */
export interface JoyCodeAdapterOptions {
  /** The user HOME: `~/.joycode` config lives here. */
  home: string;
  /** The project CWD: project-scope config lives under `<cwd>/.joycode`. */
  cwd: string;
  /** Absolute path to the selection policy (usagePaths().config). */
  selectionConfigPath: string;
  /** Directory for the skill + install + ownership manifests (usagePaths().state). */
  usageStateDir: string;
  /** Bytes of the bundled runtime copied under <home>/.joycode. */
  runtimeBundle: Uint8Array;
}

/** Owned file recorded in the ownership manifest (hash-guarded on uninstall). */
interface OwnedFile {
  path: string;
  hash: string;
}

/** On-disk ownership manifest: every byte-sealed file the installer wrote. */
interface OwnershipManifest {
  version: 1;
  files: OwnedFile[];
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

function describeError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
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

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read + JSON-parse a file, returning `undefined` when absent or malformed. */
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function emptyPolicy(): AgentSelectionPolicy {
  return { skills: { native_hook: [], injected_mcp: [] }, mcp: [] };
}

/** Determine whether a discovered entry is a wrappable stdio server. */
function isStdioEntry(entry: JoyCodeMcpEntry | undefined): boolean {
  return entry !== undefined && typeof entry.command === 'string';
}

/** True when an entry has already been wrapped by this runtime. */
function isAlreadyWrapped(entry: JoyCodeMcpEntry, runtimePath: string): boolean {
  return (
    entry.command === process.execPath &&
    Array.isArray(entry.args) &&
    entry.args[0] === runtimePath &&
    entry.args[1] === 'proxy'
  );
}

function wrapEntry(
  entry: JoyCodeMcpEntry,
  runtimePath: string,
  name: string,
): JoyCodeMcpEntry {
  return {
    ...entry,
    command: process.execPath,
    args: [
      runtimePath,
      'proxy',
      '--agent',
      JOYCODE_ADAPTER_ID,
      '--server',
      name,
      '--',
      // `command` is a string here by the isStdioEntry guard.
      ...(typeof entry.command === 'string' ? [entry.command] : []),
      ...(entry.args ?? []),
    ],
  };
}

function accountingEntry(runtimePath: string): JoyCodeMcpEntry {
  return {
    command: process.execPath,
    args: [runtimePath, 'mcp', '--agent', JOYCODE_ADAPTER_ID],
  };
}

/** A discovered skill plus its scope and canonical (realpath) path. */
interface DiscoveredJoySkill {
  name: string;
  scope: Scope;
  /** Non-realpath'd path as discovered (parent dir name = skill name). */
  path: string;
  /** Symlink-resolved absolute path; used for containment + stable id. */
  canonical: string;
}

/**
 * Build the JoyCode usage adapter. Selection is opt-in: `install`/`sync`/
 * `repair` register the accounting server but never wrap servers or inject
 * skill blocks unless a policy selects them via `configure`.
 */
export function createJoyCodeAdapter(
  options: JoyCodeAdapterOptions,
): AgentAdapter {
  const { home, cwd, selectionConfigPath, usageStateDir, runtimeBundle } =
    options;

  const paths = joyCodePaths(home, cwd);
  const runtimePath = join(home, '.joycode', RUNTIME_FILE_NAME);
  const usageSkillFile = join(paths.userSkills, USAGE_SKILL_NAME, 'SKILL.md');
  const skillManifestPath = join(usageStateDir, SKILL_MANIFEST_FILE);
  const mcpManifestPath = join(usageStateDir, MCP_MANIFEST_FILE);
  const ownershipManifestPath = join(usageStateDir, OWNERSHIP_MANIFEST_FILE);

  /**
   * Discover user + project Skills, deduplicating by canonical path across
   * roots. Only skills that live inside their root (symlink containment) and
   * parse valid YAML frontmatter are returned; everything else is reported via
   * the returned `issues`.
   *
   * Skill discovery reuses the reconciler's safety invariants — realpath
   * containment and frontmatter validation — without invoking its "instrument
   * everything" `sync()`, because selection must drive injection.
   */
  async function discoverSkills(
    issues: string[],
  ): Promise<DiscoveredJoySkill[]> {
    const roots: Array<{ root: string; scope: Scope }> = [
      { root: paths.userSkills, scope: 'user' },
      { root: paths.projectSkills, scope: 'project' },
    ];
    const found: DiscoveredJoySkill[] = [];
    const seenCanonicals = new Set<string>();
    const managedNames = new Set<string>([USAGE_SKILL_NAME]);

    for (const { root, scope } of roots) {
      let realRoot: string;
      try {
        realRoot = await realpath(root);
      } catch {
        continue; // Missing root: skip silently.
      }

      let entries: string[];
      try {
        entries = readdirSync(realRoot);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (managedNames.has(entry)) continue;
        const child = join(realRoot, entry);
        if (!isDirectory(child)) continue;
        const skillFile = join(child, 'SKILL.md');
        if (!isReadable(skillFile)) continue;

        let canonical: string;
        try {
          canonical = await realpath(skillFile);
        } catch (error) {
          issues.push(describeError(`unreadable skill ${entry}`, error));
          continue;
        }

        const rel = relative(realRoot, canonical);
        if (rel.startsWith('..')) {
          issues.push(`skill "${entry}" escapes its root via symlink`);
          continue;
        }

        if (seenCanonicals.has(canonical)) continue;
        seenCanonicals.add(canonical);

        let content: string;
        try {
          content = await readFile(canonical, 'utf8');
        } catch (error) {
          issues.push(describeError(`unreadable skill ${entry}`, error));
          continue;
        }
        const fm = content.match(CLAUDE_FRONTMATTER_RE);
        if (fm) {
          try {
            YAML.parse(fm[1] ?? '');
          } catch (error) {
            issues.push(`skill "${entry}" has malformed frontmatter: ${String(error)}`);
            continue;
          }
        }

        found.push({ name: entry, scope, path: skillFile, canonical });
      }
    }
    return found;
  }

  /** Discover configured MCP servers from the user MCP config. */
  async function discoverMcpConfig(): Promise<JoyCodeMcpConfig> {
    const parsed = await readJson<JoyCodeMcpConfig>(paths.userMcp);
    if (parsed === undefined) return {};
    return parsed;
  }

  /**
   * Selection-aware skill reconciliation. Inject the accounting block into
   * skills whose `selectedSkillMode === 'injected_mcp'`; remove the block from
   * every other discovered skill (covers deselection + native_hook). Updates the
   * skill manifest with the resulting state. Idempotent, symlink-safe, and
   * honors read-only files (degraded, never overwritten).
   */
  async function reconcileSkills(
    policy: AgentSelectionPolicy,
    issues: string[],
  ): Promise<OperationResult[]> {
    const results: OperationResult[] = [];
    const skills = await discoverSkills(issues);
    const states: Record<string, InstrumentedSkillState> = {};

    for (const skill of skills) {
      let mode: ReturnType<typeof selectedSkillMode>;
      try {
        mode = selectedSkillMode(policy, skill.name);
      } catch (error) {
        results.push(
          degraded(
            skill.path,
            describeError(`conflicting selection for ${skill.name}`, error),
          ),
        );
        continue;
      }

      let original: string;
      try {
        original = await readFile(skill.canonical, 'utf8');
      } catch (error) {
        results.push(
          degraded(skill.path, describeError('unreadable skill file', error)),
        );
        continue;
      }

      const transform =
        mode === 'injected_mcp'
          ? injectAccountingBlock(
              original,
              stableSkillId(JOYCODE_ADAPTER_ID, skill.scope, skill.canonical),
              skill.name,
            )
          : removeAccountingBlock(original);

      if (!transform.changed) {
        if (mode === 'injected_mcp') {
          states[skill.canonical] = manifestEntry(
            skill,
            original,
            original,
          );
        }
        continue;
      }

      // Read-only target: never overwrite (atomicWrite would bypass the mode).
      if (!(await isWritable(skill.canonical))) {
        results.push(
          degraded(skill.path, 'skill file is read-only; block not reconciled'),
        );
        continue;
      }

      let fileMode: number | undefined;
      try {
        fileMode = (await stat(skill.canonical)).mode & 0o777;
      } catch {
        fileMode = undefined;
      }
      try {
        await atomicWrite(
          skill.canonical,
          transform.content,
          fileMode === undefined ? 0o644 : fileMode,
        );
        if (mode === 'injected_mcp') {
          states[skill.canonical] = manifestEntry(
            skill,
            original,
            transform.content,
          );
        }
      } catch (error) {
        results.push(
          degraded(
            skill.path,
            describeError('failed to reconcile skill block', error),
          ),
        );
      }
    }

    const manifest: JoyCodeSkillManifest = { version: 1, skills: states };
    try {
      await atomicWrite(
        skillManifestPath,
        toBytes(`${JSON.stringify(manifest, null, 2)}\n`),
      );
    } catch (error) {
      results.push(
        degraded(
          skillManifestPath,
          describeError('failed to write skill manifest', error),
        ),
      );
    }

    return results;
  }

  function manifestEntry(
    skill: DiscoveredJoySkill,
    before: string,
    after: string,
  ): InstrumentedSkillState {
    return {
      canonicalPath: skill.canonical,
      skillId: stableSkillId(JOYCODE_ADAPTER_ID, skill.scope, skill.canonical),
      scope: skill.scope,
      injectionVersion: MANAGED_BLOCK_VERSION,
      beforeHash: sha256(toBytes(before)),
      afterHash: sha256(toBytes(after)),
      lastSeenAt: new Date().toISOString(),
    };
  }

  /**
   * Selection-aware MCP reconciliation. Wrap only the selected stdio servers
   * (never `usage-stats`); restore any server that was previously wrapped but
   * is no longer selected, using the persisted MCP manifest (hash-guarded; a
   * user edit yields degraded rather than an overwrite). Always registers the
   * accounting server when installing. The merged config + updated manifest are
   * persisted.
   */
  async function reconcileMcp(
    policy: AgentSelectionPolicy,
    installAccounting: boolean,
    issues: string[],
  ): Promise<OperationResult[]> {
    const results: OperationResult[] = [];

    let config: JoyCodeMcpConfig;
    try {
      const text = await readFile(paths.userMcp, 'utf8');
      config = JSON.parse(text) as JoyCodeMcpConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        config = {};
      } else {
        // Malformed JSON: never overwrite a user file we cannot parse.
        results.push(
          degraded(
            paths.userMcp,
            describeError('malformed user MCP config; left untouched', error),
          ),
        );
        return results;
      }
    }

    const servers: Record<string, JoyCodeMcpEntry> = {
      ...(config.mcpServers ?? {}),
    };

    const priorManifest = await readJson<JoyCodeMcpManifest>(mcpManifestPath);
    const originals: Record<string, JoyCodeMcpEntry> = {};
    const managedHashes: Record<string, string> = {};

    // Restore servers no longer selected but previously wrapped.
    if (priorManifest !== undefined) {
      for (const [name, original] of Object.entries(priorManifest.originals)) {
        const selected = selectedMcp(policy, name, '');
        const current = servers[name];
        if (selected) continue; // still selected: re-wrap below.
        if (current === undefined) continue; // already gone.
        const expected = priorManifest.managedHashes[name];
        const hash = hashMcpEntry(current);
        if (expected !== undefined && hash !== expected) {
          results.push(
            degraded(
              paths.userMcp,
              `preserved user edit to wrapped server "${name}" (hash mismatch)`,
            ),
          );
          continue;
        }
        servers[name] = { ...original };
      }
    }

    // Wrap newly/again selected stdio servers (skip usage-stats + remotes).
    for (const [name, entry] of Object.entries(servers)) {
      if (name === ACCOUNTING_SERVER) continue;
      if (!isStdioEntry(entry)) continue;
      const selected = selectedMcp(policy, name, '');
      if (!selected) continue;
      if (isAlreadyWrapped(entry, runtimePath)) {
        // Already wrapped: keep tracking it.
        managedHashes[name] = hashMcpEntry(entry);
        if (priorManifest?.originals[name] !== undefined) {
          originals[name] = priorManifest.originals[name];
        }
        continue;
      }
      originals[name] = { ...entry };
      const wrapped = wrapEntry(entry, runtimePath, name);
      servers[name] = wrapped;
      managedHashes[name] = hashMcpEntry(wrapped);
    }

    // Carry over originals for still-wrapped servers we did not touch this pass.
    if (priorManifest !== undefined) {
      for (const [name, entry] of Object.entries(servers)) {
        if (name === ACCOUNTING_SERVER) continue;
        if (!isAlreadyWrapped(entry, runtimePath)) continue;
        if (originals[name] !== undefined) continue;
        if (priorManifest.originals[name] !== undefined) {
          originals[name] = priorManifest.originals[name];
          managedHashes[name] =
            managedHashes[name] ?? hashMcpEntry(entry);
        }
      }
    }

    if (installAccounting) {
      servers[ACCOUNTING_SERVER] = accountingEntry(runtimePath);
    } else if (servers[ACCOUNTING_SERVER] !== undefined) {
      delete servers[ACCOUNTING_SERVER];
    }

    config.mcpServers = servers;
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    try {
      await atomicWrite(paths.userMcp, toBytes(serialized));
    } catch (error) {
      results.push(
        degraded(paths.userMcp, describeError('failed to write MCP config', error)),
      );
      return results;
    }

    const manifest: JoyCodeMcpManifest = {
      version: 1,
      originals,
      managedHashes,
    };
    try {
      await atomicWrite(
        mcpManifestPath,
        toBytes(`${JSON.stringify(manifest, null, 2)}\n`),
      );
    } catch (error) {
      results.push(
        degraded(
          mcpManifestPath,
          describeError('failed to write MCP manifest', error),
        ),
      );
    }

    // Surface remote servers that can never be proxied.
    for (const [name, entry] of Object.entries(servers)) {
      if (name === ACCOUNTING_SERVER) continue;
      if (!isStdioEntry(entry)) {
        if (selectedMcp(policy, name, '')) {
          issues.push(
            `MCP server "${name}" is not stdio and cannot be proxied`,
          );
        }
      }
    }

    return results;
  }

  /** Merge the usage-stats prompt entry into the user prompt array. */
  async function reconcilePrompts(): Promise<OperationResult[]> {
    let entries: unknown[] = [];
    let malformed = false;
    try {
      const parsed = JSON.parse(await readFile(paths.userPrompts, 'utf8'));
      if (Array.isArray(parsed)) entries = parsed;
      else malformed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') malformed = true;
    }
    if (malformed) {
      return [
        degraded(
          paths.userPrompts,
          'malformed user prompt file; left untouched',
        ),
      ];
    }
    const filtered = entries.filter(
      (entry) =>
        !(
          entry !== null &&
          typeof entry === 'object' &&
          (entry as { label?: unknown }).label === USAGE_PROMPT_LABEL
        ),
    );
    filtered.push({ ...usagePrompt });
    try {
      await atomicWrite(
        paths.userPrompts,
        toBytes(`${JSON.stringify(filtered, null, 2)}\n`),
      );
    } catch (error) {
      return [
        degraded(
          paths.userPrompts,
          describeError('failed to write prompt file', error),
        ),
      ];
    }
    return [];
  }

  /** Write the runtime bundle + usage-stats Skill and refresh ownership. */
  async function reconcileInstall(): Promise<OperationResult[]> {
    const results: OperationResult[] = [];
    const owned: OwnedFile[] = [];

    try {
      await atomicWrite(runtimePath, runtimeBundle, 0o755);
      owned.push({ path: runtimePath, hash: sha256(runtimeBundle) });
    } catch (error) {
      results.push(
        degraded(runtimePath, describeError('failed to write runtime', error)),
      );
    }

    const skillBytes = toBytes(usageSkill);
    try {
      await atomicWrite(usageSkillFile, skillBytes);
      owned.push({ path: usageSkillFile, hash: sha256(skillBytes) });
    } catch (error) {
      results.push(
        degraded(usageSkillFile, describeError('failed to write usage skill', error)),
      );
    }

    const manifest: OwnershipManifest = { version: 1, files: owned };
    try {
      await atomicWrite(
        ownershipManifestPath,
        toBytes(`${JSON.stringify(manifest, null, 2)}\n`),
      );
    } catch (error) {
      results.push(
        degraded(
          ownershipManifestPath,
          describeError('failed to write ownership manifest', error),
        ),
      );
    }

    return results;
  }

  async function loadOwnPolicy(): Promise<AgentSelectionPolicy> {
    try {
      const config = await loadSelectionConfig(selectionConfigPath);
      return config.agents[JOYCODE_ADAPTER_ID] ?? emptyPolicy();
    } catch {
      return emptyPolicy();
    }
  }

  /**
   * Full opt-in reconciliation against `policy`: install runtime + skill,
   * register accounting server, then selection-aware skill + MCP reconcile.
   * Used by install/sync/repair (idempotent) and configure (after persisting).
   */
  async function reconcileAll(
    policy: AgentSelectionPolicy,
    issues: string[],
  ): Promise<OperationResult[]> {
    const results: OperationResult[] = [];
    results.push(...(await reconcileInstall()));
    results.push(...(await reconcilePrompts()));
    results.push(...(await reconcileMcp(policy, true, issues)));
    results.push(...(await reconcileSkills(policy, issues)));
    return results;
  }

  async function adapterDiscover(): Promise<string[]> {
    const installed =
      existsSync(ownershipManifestPath) && existsSync(runtimePath);
    if (!installed) return [];
    return [paths.userMcp, paths.userSkills];
  }

  async function adapterListTargets(): Promise<DiscoveredTargets> {
    const policy = await loadOwnPolicy();
    const issues: string[] = [];
    const skills = await discoverSkills(issues);
    const skillRecords: DiscoveredSkill[] = skills.map((skill) => {
      let selectedMode: DiscoveredSkill['selectedMode'];
      try {
        selectedMode = selectedSkillMode(policy, skill.name);
      } catch {
        issues.push(
          `Skill "${skill.name}" matches both native_hook and injected_mcp`,
        );
        selectedMode = undefined;
      }
      const record: DiscoveredSkill = {
        name: skill.name,
        scope: skill.scope,
        path: skill.path,
        supportedModes: ['injected_mcp'],
        ...(selectedMode === undefined ? {} : { selectedMode }),
      };
      return record;
    });

    const config = await discoverMcpConfig();
    const servers = config.mcpServers ?? {};
    const mcp: DiscoveredMcp[] = [];
    for (const name of Object.keys(servers)) {
      const entry = servers[name];
      const transport = transportOf(entry);
      mcp.push({
        server: name,
        scope: 'user',
        transport,
        selected:
          name !== ACCOUNTING_SERVER && selectedMcp(policy, name, ''),
      });
    }

    const unresolved = unresolvedPatterns(policy, skillRecords, mcp);
    return {
      agent: JOYCODE_ADAPTER_ID,
      skills: skillRecords,
      mcp: mcp.sort((a, b) => a.server.localeCompare(b.server)),
      unresolved,
      issues: [...issues].sort(),
    };
  }

  async function adapterConfigure(
    policy: AgentSelectionPolicy,
  ): Promise<OperationResult[]> {
    // (1) Persist the policy for this agent.
    let config: SelectionConfig;
    try {
      config = await loadSelectionConfig(selectionConfigPath);
    } catch {
      config = { version: 1, agents: {} };
    }
    const nextConfig: SelectionConfig = {
      version: 1,
      agents: { ...config.agents, [JOYCODE_ADAPTER_ID]: policy },
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

    // (2) Reconcile skills + MCP against the just-persisted policy.
    const issues: string[] = [];
    const results = await reconcileAll(policy, issues);
    const flat = [...results];
    for (const issue of issues) {
      flat.push(degraded(selectionConfigPath, issue));
    }
    if (flat.length === 0) {
      return [success(selectionConfigPath, 'configured joycode selection policy')];
    }
    return flat;
  }

  async function adapterInstall(scope: Scope): Promise<OperationResult[]> {
    // install alone is opt-in: reconcile against the CURRENT policy (no policy
    // => accounting server only, nothing wrapped, nothing injected).
    const policy = await loadOwnPolicy();
    const issues: string[] = [];
    const results = await reconcileAll(policy, issues);
    const flat = [...results];
    for (const issue of issues) flat.push(degraded(runtimePath, issue));
    if (flat.length === 0) {
      return [success(runtimePath, `installed joycode adapter (${scope})`)];
    }
    return flat;
  }

  async function adapterSync(scope: Scope): Promise<OperationResult[]> {
    return adapterInstall(scope);
  }

  async function adapterRepair(scope: Scope): Promise<OperationResult[]> {
    return adapterInstall(scope);
  }

  async function adapterUninstall(scope: Scope): Promise<OperationResult[]> {
    const results: OperationResult[] = [];

    // (1) Restore the user MCP config (hash-guarded).
    const mcpManifest = await readJson<JoyCodeMcpManifest>(mcpManifestPath);
    if (mcpManifest !== undefined) {
      let config: JoyCodeMcpConfig | undefined;
      try {
        config = JSON.parse(await readFile(paths.userMcp, 'utf8')) as JoyCodeMcpConfig;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          results.push(
            degraded(
              paths.userMcp,
              describeError('malformed MCP config; left untouched', error),
            ),
          );
        }
      }
      if (config !== undefined) {
        try {
          const restored = restoreJoyCodeMcpConfig(config, mcpManifest);
          await atomicWrite(
            paths.userMcp,
            toBytes(`${JSON.stringify(restored, null, 2)}\n`),
          );
        } catch (error) {
          results.push(
            degraded(
              paths.userMcp,
              describeError('preserved user-edited MCP entry', error),
            ),
          );
        }
      }
    }

    // (2) Remove the usage-stats prompt entry (preserve siblings).
    try {
      const parsed = JSON.parse(await readFile(paths.userPrompts, 'utf8'));
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter(
          (entry: unknown) =>
            !(
              entry !== null &&
              typeof entry === 'object' &&
              (entry as { label?: unknown }).label === USAGE_PROMPT_LABEL
            ),
        );
        await atomicWrite(
          paths.userPrompts,
          toBytes(`${JSON.stringify(filtered, null, 2)}\n`),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        results.push(
          degraded(paths.userPrompts, describeError('could not update prompts', error)),
        );
      }
    }

    // (3) Remove accounting blocks from all instrumented skills.
    const skillManifest = await readJson<JoyCodeSkillManifest>(skillManifestPath);
    if (skillManifest?.skills !== undefined) {
      for (const state of Object.values(skillManifest.skills)) {
        try {
          const content = await readFile(state.canonicalPath, 'utf8');
          const { content: stripped, changed } = removeAccountingBlock(content);
          if (changed) {
            if (!(await isWritable(state.canonicalPath))) {
              results.push(
                degraded(
                  state.canonicalPath,
                  'read-only skill; accounting block not removed',
                ),
              );
              continue;
            }
            await atomicWrite(state.canonicalPath, toBytes(stripped));
          }
        } catch (error) {
          results.push(
            degraded(
              state.canonicalPath,
              describeError('failed to remove accounting block', error),
            ),
          );
        }
      }
    }

    // (4) Remove owned files (hash match), preserve user-edited ones.
    const ownership = await readJson<OwnershipManifest>(ownershipManifestPath);
    if (ownership?.files !== undefined) {
      for (const owned of ownership.files) {
        try {
          const currentHash = await sha256File(owned.path);
          if (currentHash !== owned.hash) {
            results.push(
              degraded(owned.path, 'preserved user-edited file (hash mismatch)'),
            );
            continue;
          }
          await rm(owned.path, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          results.push(
            degraded(owned.path, describeError('failed to remove owned file', error)),
          );
        }
      }
    }

    // (5) Remove manifests.
    for (const file of [
      skillManifestPath,
      mcpManifestPath,
      ownershipManifestPath,
    ]) {
      try {
        await rm(file, { force: true });
      } catch (error) {
        results.push(degraded(file, describeError('failed to remove manifest', error)));
      }
    }

    // (6) Remove the usage-stats skill directory if empty.
    const usageSkillDir = join(paths.userSkills, USAGE_SKILL_NAME);
    if (existsSync(usageSkillDir)) {
      try {
        await rm(usageSkillDir, { recursive: true, force: true });
      } catch (error) {
        results.push(
          degraded(usageSkillDir, describeError('failed to remove usage skill dir', error)),
        );
      }
    }

    if (results.length === 0) {
      return [success(runtimePath, `uninstalled joycode adapter (${scope})`)];
    }
    return results;
  }

  /**
   * Build the live-session MCP lifecycle: a skill watcher over the user + project
   * skill roots (delivering the advertised `skillWatching` capability) whose
   * `start()` runs an initial `sync()` + arms the debounced watcher, and whose
   * `close()` clears the watcher handle (no leaked FS handles). The reconciler
   * writes the same skill manifest used by sync/uninstall, so skills created or
   * edited during a JoyCode MCP session are re-instrumented incrementally.
   */
  async function adapterCreateMcpLifecycle(): Promise<McpLifecycle | undefined> {
    const reconciler = new JoyCodeSkillReconciler({
      roots: [
        { path: paths.userSkills, scope: 'user' },
        { path: paths.projectSkills, scope: 'project' },
      ],
      stateFile: skillManifestPath,
    });
    let handle: { close(): Promise<void> } | undefined;
    return {
      async start(): Promise<void> {
        handle = await reconciler.watch();
      },
      async close(): Promise<void> {
        await handle?.close();
        handle = undefined;
      },
    };
  }

  async function adapterHealth(): Promise<CoverageReport> {
    const runtimePresent = existsSync(runtimePath);
    if (!runtimePresent) {
      return {
        agent: JOYCODE_ADAPTER_ID,
        skills: 'unavailable',
        mcp: 'unavailable',
        issues: ['runtime not installed'],
      };
    }

    const policy = await loadOwnPolicy();
    const issues: string[] = [];
    const config = await discoverMcpConfig();
    const servers = config.mcpServers ?? {};
    let wrappedCount = 0;
    let remoteSelected = false;
    for (const [name, entry] of Object.entries(servers)) {
      if (name === ACCOUNTING_SERVER) continue;
      if (isAlreadyWrapped(entry, runtimePath)) {
        wrappedCount += 1;
      } else if (!isStdioEntry(entry) && selectedMcp(policy, name, '')) {
        remoteSelected = true;
        issues.push(`MCP server "${name}" is not stdio and cannot be proxied`);
      }
    }
    if (remoteSelected) {
      // surfaced above
    }

    const accountingPresent = servers[ACCOUNTING_SERVER] !== undefined;
    if (!accountingPresent) {
      issues.push('usage-stats accounting server missing');
    }

    const skillManifest = await readJson<JoyCodeSkillManifest>(skillManifestPath);
    const injectedCount = skillManifest?.skills
      ? Object.keys(skillManifest.skills).length
      : 0;

    const mcpCoverage =
      wrappedCount === 0
        ? 'exact (stdio-only, none wrapped)'
        : `exact (stdio-only, ${wrappedCount} wrapped)`;

    return {
      agent: JOYCODE_ADAPTER_ID,
      skills: injectedCount === 0 ? 'none injected' : 'best-effort (injected)',
      mcp: mcpCoverage,
      issues: [...issues].sort(),
    };
  }

  return {
    id: JOYCODE_ADAPTER_ID,
    capabilities: JOYCODE_CAPABILITIES,
    discover: adapterDiscover,
    listTargets: adapterListTargets,
    configure: adapterConfigure,
    install: adapterInstall,
    sync: adapterSync,
    repair: adapterRepair,
    uninstall: adapterUninstall,
    health: adapterHealth,
    createMcpLifecycle: adapterCreateMcpLifecycle,
  };
}

function transportOf(entry: JoyCodeMcpEntry | undefined): DiscoveredMcp['transport'] {
  if (entry === undefined) return 'unknown';
  const declared = entry.type;
  if (typeof declared === 'string') {
    if (declared === 'stdio') return 'stdio';
    if (declared === 'http') return 'http';
    if (declared === 'sse') return 'sse';
  }
  if (typeof entry.url === 'string') return entry.url.startsWith('http') ? 'http' : 'sse';
  if (typeof entry.command === 'string') return 'stdio';
  return 'unknown';
}

/** Glob-style pattern match (same semantics as core/selection). */
function patternMatches(pattern: string, value: string): boolean {
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
  return pattern.endsWith('*') || cursor === value.length;
}

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
  const skillNames = skills.map((s) => s.name);
  const serverNames = mcp.map((s) => s.server);
  return [...new Set(allPatterns)]
    .filter(
      (pattern) =>
        !skillNames.some((name) => patternMatches(pattern, name)) &&
        !serverNames.some((name) => patternMatches(pattern, name)),
    )
    .sort();
}

/**
 * Read the real runtime bundle from the build output. Mirrors the Claude
 * adapter's lookup: from source the bundle is `<root>/dist/agent-usage.mjs`;
 * when the bundled runtime is itself the entrypoint it reads its own bytes.
 */
export async function readRuntimeBundle(): Promise<Uint8Array> {
  const candidates = [
    new URL('../../../dist/agent-usage.mjs', import.meta.url),
    new URL('agent-usage.mjs', import.meta.url),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Build the default JoyCode adapter against the real user HOME/CWD and the real
 * selection-config + usage-state paths. Returns `undefined` when the runtime
 * bundle cannot be read so the CLI can skip registration gracefully.
 */
export async function defaultJoyCodeAdapter(): Promise<AgentAdapter | undefined> {
  let runtimeBundle: Uint8Array;
  try {
    runtimeBundle = await readRuntimeBundle();
  } catch {
    return undefined;
  }
  return createJoyCodeAdapter({
    home: homedir(),
    cwd: process.cwd(),
    selectionConfigPath: usagePaths().config,
    usageStateDir: usagePaths().state,
    runtimeBundle,
  });
}
