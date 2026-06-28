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
import { usagePaths } from '../../core/paths.js';
import {
  emptyAgentSelection,
  loadSelectionConfig,
  saveSelectionConfig,
  selectedMcp,
  selectedSkillMode,
  type AgentSelectionPolicy,
  type SelectionConfig,
} from '../../core/selection.js';
import {
  injectAccountingBlock,
  removeAccountingBlock,
} from '../joycode/skill-file.js';
import { CODEX_ADAPTER_ID } from './normalize.js';
import { CodexSessionLogIngestor } from './session-log.js';
import type { McpLifecycle } from '../../mcp/server.js';

const ACCOUNTING_SERVER = 'usage-stats';
const RUNTIME_FILE = 'agent-usage/runtime/agent-usage.mjs';
const SKILL_MANIFEST_FILE = 'codex-skill-manifest.json';
const SESSION_LOG_STATE_FILE = 'codex-session-log-state.json';
const CODEX_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MANAGED_TOML_BEGIN = '# agent-usage:begin usage-stats';
const MANAGED_TOML_END = '# agent-usage:end usage-stats';

const CODEX_CAPABILITIES: Capabilities = {
  nativeSkillEvents: false,
  skillInjection: true,
  nativeMcpEvents: true,
  stdioMcpProxy: false,
  skillWatching: false,
};

export interface CodexAdapterOptions {
  home: string;
  selectionConfigPath: string;
  usageStateDir: string;
  usageDatabasePath: string;
  runtimeBundle: Uint8Array;
}

interface DiscoveredCodexSkill {
  name: string;
  scope: Scope;
  path: string;
  canonical: string;
}

interface CodexSkillManifest {
  version: 1;
  skills: Record<
    string,
    {
      canonicalPath: string;
      skillId: string;
      scope: Scope;
      beforeHash: string;
      afterHash: string;
      lastSeenAt: string;
    }
  >;
}

interface CodexMcpServer {
  name: string;
  transport: DiscoveredMcp['transport'];
}

function toBytes(content: string): Uint8Array {
  return Buffer.from(content, 'utf8');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

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
  const skillNames = skills.map((skill) => skill.name);
  const serverNames = mcp.map((server) => server.server);
  return [...new Set(allPatterns)]
    .filter(
      (pattern) =>
        !skillNames.some((name) => patternMatches(pattern, name)) &&
        !serverNames.some((name) => patternMatches(pattern, name)),
    )
    .sort();
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

interface HooksJson {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

function hookCommand(runtimePath: string): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(runtimePath)} hook codex`;
}

function managedHookEntry(runtimePath: string): HookEntry {
  return {
    matcher: '^mcp__.*',
    hooks: [{ type: 'command', command: hookCommand(runtimePath) }],
  };
}

function mergeHookEntries(
  existing: HookEntry[] | undefined,
  runtimePath: string,
): HookEntry[] {
  const command = hookCommand(runtimePath);
  const filtered = (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some(
        (hook) =>
          hook.type === 'command' &&
          typeof hook.command === 'string' &&
          hook.command.includes(' hook codex'),
      ),
  );
  return [...filtered, managedHookEntry(runtimePath)];
}

function stripHookEntries(existing: HookEntry[] | undefined): HookEntry[] {
  return (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some(
        (hook) =>
          hook.type === 'command' &&
          typeof hook.command === 'string' &&
          hook.command.includes(' hook codex'),
      ),
  );
}

function codexMcpTomlBlock(runtimePath: string): string {
  return [
    MANAGED_TOML_BEGIN,
    '[mcp_servers.usage-stats]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${[runtimePath, 'mcp', '--agent', CODEX_ADAPTER_ID]
      .map((value) => JSON.stringify(value))
      .join(', ')}]`,
    MANAGED_TOML_END,
    '',
  ].join('\n');
}

function removeManagedTomlBlock(content: string): string {
  const begin = content.indexOf(MANAGED_TOML_BEGIN);
  if (begin === -1) return content;
  const end = content.indexOf(MANAGED_TOML_END, begin);
  if (end === -1) return content;
  const afterEnd = end + MANAGED_TOML_END.length;
  const trailingNewline = content.slice(afterEnd).startsWith('\n') ? 1 : 0;
  return `${content.slice(0, begin)}${content.slice(afterEnd + trailingNewline)}`;
}

function unquoteTomlKey(key: string): string {
  const trimmed = key.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function topLevelTomlKey(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    if (quote === undefined) return null;
    const end = trimmed.indexOf(quote, 1);
    if (end <= 0) return null;
    const rest = trimmed.slice(end + 1).trim();
    if (rest.length > 0) return null;
    return unquoteTomlKey(trimmed);
  }
  if (trimmed.includes('.')) return null;
  return trimmed;
}

function parseCodexMcpServers(configToml: string): CodexMcpServer[] {
  const servers: CodexMcpServer[] = [];
  const tablePattern = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;
  const matches = [...configToml.matchAll(tablePattern)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match === undefined) continue;
    const rawName = match?.[1];
    if (rawName === undefined || match.index === undefined) continue;
    const name = topLevelTomlKey(rawName);
    if (name === null) continue;
    if (name === ACCOUNTING_SERVER) continue;

    const blockStart = match.index + match[0].length;
    const nextMatch = matches[index + 1];
    const blockEnd = nextMatch?.index ?? configToml.length;
    const block = configToml.slice(blockStart, blockEnd);
    const hasCommand = /^\s*command\s*=/m.test(block);
    const url = block.match(/^\s*url\s*=\s*["']([^"']+)["']/m)?.[1];
    const transport: DiscoveredMcp['transport'] = hasCommand
      ? 'stdio'
      : url === undefined
        ? 'unknown'
        : url.startsWith('http')
          ? 'http'
          : 'sse';

    servers.push({ name, transport });
  }

  return servers;
}

export function createCodexAdapter(options: CodexAdapterOptions): AgentAdapter {
  const {
    home,
    selectionConfigPath,
    usageStateDir,
    usageDatabasePath,
    runtimeBundle,
  } = options;
  const codexRoot = join(home, '.codex');
  const skillsRoot = join(codexRoot, 'skills');
  const runtimePath = join(codexRoot, RUNTIME_FILE);
  const hooksPath = join(codexRoot, 'hooks.json');
  const configTomlPath = join(codexRoot, 'config.toml');
  const skillManifestPath = join(usageStateDir, SKILL_MANIFEST_FILE);
  const sessionLogStatePath = join(usageStateDir, SESSION_LOG_STATE_FILE);
  const sessionsRoot = join(codexRoot, 'sessions');

  async function loadOwnPolicy(): Promise<AgentSelectionPolicy> {
    try {
      const config = await loadSelectionConfig(selectionConfigPath);
      return config.agents[CODEX_ADAPTER_ID] ?? emptyAgentSelection();
    } catch {
      return emptyAgentSelection();
    }
  }

  async function discoverSkills(
    issues: string[],
  ): Promise<DiscoveredCodexSkill[]> {
    let realRoot: string;
    try {
      realRoot = await realpath(skillsRoot);
    } catch {
      return [];
    }

    const found: DiscoveredCodexSkill[] = [];
    for (const entry of readdirSync(realRoot).sort((a, b) => a.localeCompare(b))) {
      if (entry.startsWith('.')) continue;
      const child = join(realRoot, entry);
      if (!isDirectory(child)) continue;
      const skillFile = join(child, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      let canonical: string;
      try {
        canonical = await realpath(skillFile);
      } catch (error) {
        issues.push(describeError(`unreadable skill ${entry}`, error));
        continue;
      }

      const rel = relative(realRoot, canonical);
      if (rel.startsWith('..')) {
        issues.push(`skill "${entry}" escapes ~/.codex/skills via symlink`);
        continue;
      }

      try {
        const content = await readFile(canonical, 'utf8');
        const fm = content.match(CODEX_FRONTMATTER_RE);
        if (fm) YAML.parse(fm[1] ?? '');
      } catch (error) {
        issues.push(`skill "${entry}" has malformed frontmatter: ${String(error)}`);
        continue;
      }

      found.push({ name: entry, scope: 'user', path: skillFile, canonical });
    }
    return found;
  }

  async function discoverMcp(policy: AgentSelectionPolicy): Promise<DiscoveredMcp[]> {
    let content: string;
    try {
      content = await readFile(configTomlPath, 'utf8');
    } catch {
      return [];
    }

    return parseCodexMcpServers(content)
      .map((server) => ({
        server: server.name,
        scope: 'user' as const,
        transport: server.transport,
        selected: selectedMcp(policy, server.name, ''),
      }))
      .sort((left, right) => left.server.localeCompare(right.server));
  }

  async function reconcileRuntimeAndHooks(): Promise<OperationResult[]> {
    const results: OperationResult[] = [];

    try {
      await atomicWrite(runtimePath, runtimeBundle, 0o755);
    } catch (error) {
      results.push(
        degraded(runtimePath, describeError('failed to write runtime', error)),
      );
    }

    let hooks: HooksJson = {};
    try {
      hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as HooksJson;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        results.push(
          degraded(hooksPath, describeError('malformed hooks.json; left untouched', error)),
        );
        return results;
      }
    }

    const nextHooks: HooksJson = {
      ...hooks,
      hooks: {
        ...(hooks.hooks ?? {}),
        PostToolUse: mergeHookEntries(hooks.hooks?.PostToolUse, runtimePath),
        PostToolUseFailure: mergeHookEntries(
          hooks.hooks?.PostToolUseFailure,
          runtimePath,
        ),
      },
    };
    try {
      await atomicWrite(hooksPath, `${JSON.stringify(nextHooks, null, 2)}\n`);
    } catch (error) {
      results.push(
        degraded(hooksPath, describeError('failed to write hooks.json', error)),
      );
    }

    try {
      let content = '';
      try {
        content = await readFile(configTomlPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const clean = removeManagedTomlBlock(content).trimEnd();
      const next = `${clean}${clean.length === 0 ? '' : '\n\n'}${codexMcpTomlBlock(runtimePath)}`;
      await atomicWrite(configTomlPath, next);
    } catch (error) {
      results.push(
        degraded(configTomlPath, describeError('failed to write config.toml', error)),
      );
    }

    return results;
  }

  async function reconcileSkills(
    policy: AgentSelectionPolicy,
    issues: string[],
  ): Promise<OperationResult[]> {
    const results: OperationResult[] = [];
    const skills = await discoverSkills(issues);
    const manifest: CodexSkillManifest = { version: 1, skills: {} };

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

      const skillId = stableSkillId(
        CODEX_ADAPTER_ID,
        skill.scope,
        skill.canonical,
      );
      const transform =
        mode === 'injected_mcp'
          ? injectAccountingBlock(original, skillId, skill.name)
          : removeAccountingBlock(original);

      if (transform.changed) {
        if (!(await isWritable(skill.canonical))) {
          results.push(
            degraded(skill.path, 'skill file is read-only; block not reconciled'),
          );
          continue;
        }
        let fileMode = 0o644;
        try {
          fileMode = (await stat(skill.canonical)).mode & 0o777;
        } catch {
          fileMode = 0o644;
        }
        try {
          await atomicWrite(skill.canonical, transform.content, fileMode);
        } catch (error) {
          results.push(
            degraded(
              skill.path,
              describeError('failed to reconcile skill block', error),
            ),
          );
          continue;
        }
      }

      if (mode === 'injected_mcp') {
        manifest.skills[skill.canonical] = {
          canonicalPath: skill.canonical,
          skillId,
          scope: skill.scope,
          beforeHash: sha256(toBytes(original)),
          afterHash: sha256(toBytes(transform.content)),
          lastSeenAt: new Date().toISOString(),
        };
      }
    }

    try {
      await atomicWrite(
        skillManifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
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

  async function adapterListTargets(): Promise<DiscoveredTargets> {
    const policy = await loadOwnPolicy();
    const issues: string[] = [];
    const discovered = await discoverSkills(issues);
    const skills: DiscoveredSkill[] = discovered.map((skill) => {
      let selectedMode: DiscoveredSkill['selectedMode'];
      try {
        selectedMode = selectedSkillMode(policy, skill.name);
      } catch {
        issues.push(
          `Skill "${skill.name}" matches both native_hook and injected_mcp`,
        );
      }
      return {
        name: skill.name,
        scope: 'user',
        path: skill.path,
        supportedModes: ['injected_mcp'],
        ...(selectedMode === undefined ? {} : { selectedMode }),
      };
    });
    const mcp = await discoverMcp(policy);
    return {
      agent: CODEX_ADAPTER_ID,
      skills,
      mcp,
      unresolved: unresolvedPatterns(policy, skills, mcp),
      issues,
    };
  }

  async function adapterConfigure(
    policy: AgentSelectionPolicy,
  ): Promise<OperationResult[]> {
    let config: SelectionConfig;
    try {
      config = await loadSelectionConfig(selectionConfigPath);
    } catch {
      config = { version: 1, agents: {} };
    }

    const nextConfig: SelectionConfig = {
      version: 1,
      agents: { ...config.agents, [CODEX_ADAPTER_ID]: policy },
      ...(config.webhook === undefined ? {} : { webhook: config.webhook }),
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

    const issues: string[] = [];
    const results = [
      ...(await reconcileRuntimeAndHooks()),
      ...(await reconcileSkills(policy, issues)),
    ];
    for (const issue of issues) results.push(degraded(selectionConfigPath, issue));
    if (results.length === 0) {
      return [success(selectionConfigPath, 'configured codex selection policy')];
    }
    return results;
  }

  async function adapterInstall(scope: Scope): Promise<OperationResult[]> {
    const issues: string[] = [];
    const policy = await loadOwnPolicy();
    const results = [
      ...(await reconcileRuntimeAndHooks()),
      ...(await reconcileSkills(policy, issues)),
    ];
    try {
      const ingestor = new CodexSessionLogIngestor({
        sessionsRoot,
        selectionConfigPath,
        databasePath: usageDatabasePath,
        stateFile: sessionLogStatePath,
        logger: console,
      });
      const inserted = await ingestor.sync();
      if (inserted > 0) {
        results.push(
          success(
            sessionLogStatePath,
            `synced ${inserted} codex MCP session-log event${inserted === 1 ? '' : 's'}`,
          ),
        );
      }
    } catch (error) {
      results.push(
        degraded(
          sessionLogStatePath,
          describeError('failed to sync Codex session logs', error),
        ),
      );
    }
    for (const issue of issues) results.push(degraded(runtimePath, issue));
    if (results.length === 0) {
      return [success(runtimePath, `installed codex adapter (${scope})`)];
    }
    return results;
  }

  async function adapterCreateMcpLifecycle(): Promise<McpLifecycle | undefined> {
    const ingestor = new CodexSessionLogIngestor({
      sessionsRoot,
      selectionConfigPath,
      databasePath: usageDatabasePath,
      stateFile: sessionLogStatePath,
      logger: console,
    });
    let handle: Awaited<ReturnType<CodexSessionLogIngestor['watch']>> | undefined;
    return {
      async start(): Promise<void> {
        handle = await ingestor.watch();
      },
      async close(): Promise<void> {
        await handle?.close();
        handle = undefined;
      },
    };
  }

  async function adapterUninstall(scope: Scope): Promise<OperationResult[]> {
    const results: OperationResult[] = [];

    const manifest = await readJson<CodexSkillManifest>(skillManifestPath);
    for (const state of Object.values(manifest?.skills ?? {})) {
      try {
        const content = await readFile(state.canonicalPath, 'utf8');
        const stripped = removeAccountingBlock(content);
        if (stripped.changed) await atomicWrite(state.canonicalPath, stripped.content);
      } catch (error) {
        results.push(
          degraded(
            state.canonicalPath,
            describeError('failed to remove accounting block', error),
          ),
        );
      }
    }

    try {
      const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as HooksJson;
      const nextHooks: HooksJson = {
        ...hooks,
        hooks: {
          ...(hooks.hooks ?? {}),
          PostToolUse: stripHookEntries(hooks.hooks?.PostToolUse),
          PostToolUseFailure: stripHookEntries(hooks.hooks?.PostToolUseFailure),
        },
      };
      await atomicWrite(hooksPath, `${JSON.stringify(nextHooks, null, 2)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        results.push(degraded(hooksPath, describeError('failed to update hooks', error)));
      }
    }

    try {
      const content = await readFile(configTomlPath, 'utf8');
      await atomicWrite(configTomlPath, removeManagedTomlBlock(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        results.push(
          degraded(configTomlPath, describeError('failed to update config.toml', error)),
        );
      }
    }

    for (const target of [skillManifestPath, join(codexRoot, 'agent-usage')]) {
      try {
        await rm(target, { recursive: true, force: true });
      } catch (error) {
        results.push(degraded(target, describeError('failed to remove file', error)));
      }
    }

    if (results.length === 0) {
      return [success(runtimePath, `uninstalled codex adapter (${scope})`)];
    }
    return results;
  }

  async function adapterHealth(): Promise<CoverageReport> {
    const issues: string[] = [];
    if (!existsSync(runtimePath)) issues.push('runtime not installed');
    if (!existsSync(hooksPath)) issues.push('Codex hooks not installed');
    if (!existsSync(configTomlPath)) issues.push('usage-stats MCP not installed');

    return {
      agent: CODEX_ADAPTER_ID,
      skills: existsSync(skillManifestPath) ? 'best-effort (injected)' : 'none injected',
      mcp: existsSync(hooksPath) ? 'native' : 'unavailable',
      issues,
    };
  }

  return {
    id: CODEX_ADAPTER_ID,
    capabilities: CODEX_CAPABILITIES,
    async discover(): Promise<string[]> {
      return existsSync(runtimePath) ? [hooksPath, skillsRoot] : [];
    },
    listTargets: adapterListTargets,
    configure: adapterConfigure,
    install: adapterInstall,
    sync: adapterInstall,
    repair: adapterInstall,
    uninstall: adapterUninstall,
    health: adapterHealth,
    createMcpLifecycle: adapterCreateMcpLifecycle,
  };
}

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

export async function defaultCodexAdapter(): Promise<AgentAdapter | undefined> {
  let runtimeBundle: Uint8Array;
  try {
    runtimeBundle = await readRuntimeBundle();
  } catch {
    return undefined;
  }
  return createCodexAdapter({
    home: homedir(),
    selectionConfigPath: usagePaths().config,
    usageStateDir: usagePaths().state,
    usageDatabasePath: usagePaths().database,
    runtimeBundle,
  });
}
