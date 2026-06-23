import { createHash } from 'node:crypto';

/**
 * JoyCode MCP configuration shapes.
 *
 * A JoyCode MCP config (`joycode-mcp.json`) is an arbitrary JSON object that
 * MAY contain an `mcpServers` map. Each entry is either a stdio server (a
 * string `command`, optionally with `args`/`env`) or a remote server (`url`).
 * Additional top-level fields and per-entry fields are preserved verbatim.
 */
export interface JoyCodeMcpEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [key: string]: unknown;
}

export interface JoyCodeMcpConfig {
  mcpServers?: Record<string, JoyCodeMcpEntry>;
  [key: string]: unknown;
}

export interface JoyCodeMcpManifest {
  version: 1;
  originals: Record<string, JoyCodeMcpEntry>;
  managedHashes: Record<string, string>;
}

export interface InstrumentedJoyCodeMcpConfig {
  config: JoyCodeMcpConfig;
  manifest: JoyCodeMcpManifest;
}

const ACCOUNTING_SERVER = 'usage-stats';

/**
 * Deterministic JSON serialization so structurally-equal entries always produce
 * the same hash regardless of key insertion order. Recursively sorts object keys.
 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashEntry(entry: JoyCodeMcpEntry): string {
  return createHash('sha256').update(stableSerialize(entry)).digest('hex');
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isAlreadyWrapped(
  entry: JoyCodeMcpEntry,
  runtimePath: string,
): boolean {
  return (
    entry.command === process.execPath &&
    Array.isArray(entry.args) &&
    entry.args[0] === runtimePath &&
    entry.args[1] === 'proxy'
  );
}

/**
 * Wrap a JoyCode MCP config so each stdio server traverses the transparent
 * proxy (exact telemetry) and the accounting `usage-stats` server is registered.
 *
 * Pure: the input is never mutated. Idempotent: re-running on an already
 * instrumented config yields an identical config and manifest.
 */
export function instrumentJoyCodeMcpConfig(
  input: JoyCodeMcpConfig,
  runtimePath: string,
): InstrumentedJoyCodeMcpConfig {
  const config = deepClone(input);
  const servers: Record<string, JoyCodeMcpEntry> = {
    ...(config.mcpServers ?? {}),
  };
  const originals: Record<string, JoyCodeMcpEntry> = {};
  const managedHashes: Record<string, string> = {};

  for (const [name, entry] of Object.entries(servers)) {
    if (name === ACCOUNTING_SERVER) {
      continue;
    }
    if (typeof entry.command !== 'string') {
      // Remote / url entry (or otherwise non-stdio) — leave untouched.
      continue;
    }
    if (isAlreadyWrapped(entry, runtimePath)) {
      // Previously wrapped by us; do not double-wrap.
      continue;
    }
    const original = deepClone(entry);
    originals[name] = original;
    const wrapped: JoyCodeMcpEntry = {
      ...entry,
      command: process.execPath,
      args: [
        runtimePath,
        'proxy',
        '--agent',
        'joycode',
        '--server',
        name,
        '--',
        entry.command,
        ...(entry.args ?? []),
      ],
    };
    servers[name] = wrapped;
    managedHashes[name] = hashEntry(wrapped);
  }

  // Register the accounting MCP server (overwrite any stale entry).
  servers[ACCOUNTING_SERVER] = {
    command: process.execPath,
    args: [runtimePath, 'mcp', '--agent', 'joycode'],
  };

  config.mcpServers = servers;

  const manifest: JoyCodeMcpManifest = {
    version: 1,
    originals,
    managedHashes,
  };
  return { config, manifest };
}

/**
 * Restore a JoyCode MCP config to its pre-instrumentation state.
 *
 * If a managed entry was edited by the user since instrumentation (its hash no
 * longer matches), this throws naming the entry rather than overwriting the
 * edit — the adapter should catch this and report `degraded`. Pure: the input is
 * never mutated.
 */
export function restoreJoyCodeMcpConfig(
  input: JoyCodeMcpConfig,
  manifest: JoyCodeMcpManifest,
): JoyCodeMcpConfig {
  const config = deepClone(input);
  const servers: Record<string, JoyCodeMcpEntry> = {
    ...(config.mcpServers ?? {}),
  };

  for (const [name, original] of Object.entries(manifest.originals)) {
    const current = servers[name];
    if (current === undefined) {
      throw new Error(
        `Cannot restore MCP entry "${name}": it is no longer present in the config`,
      );
    }
    const expected = manifest.managedHashes[name];
    if (hashEntry(current) !== expected) {
      throw new Error(
        `Cannot restore MCP entry "${name}": it was modified since instrumentation`,
      );
    }
    servers[name] = deepClone(original);
  }

  delete servers[ACCOUNTING_SERVER];
  config.mcpServers = servers;
  return config;
}
