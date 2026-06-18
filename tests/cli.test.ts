import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdapterRegistry } from '../src/adapters/registry.js';
import type {
  AgentAdapter,
  Capabilities,
  CoverageReport,
  OperationResult,
  Scope,
} from '../src/adapters/types.js';
import { createProgram, runCli, type CliRuntime } from '../src/cli.js';
import { openUsageDatabase } from '../src/core/database.js';
import { UsageRepository } from '../src/core/repository.js';
import type { UsageMcpService } from '../src/mcp/service.js';
import type {
  StdioProtocolObserver,
  StdioProxyOptions,
} from '../src/proxy/stdio-proxy.js';
import { usageEvent } from './helpers/usage-fixtures.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const capabilities: Capabilities = {
  nativeSkillEvents: true,
  skillInjection: false,
  nativeMcpEvents: false,
  stdioMcpProxy: true,
  skillWatching: false,
};

interface FakeAdapter extends AgentAdapter {
  discover: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
  install: ReturnType<
    typeof vi.fn<(scope: Scope) => Promise<OperationResult[]>>
  >;
  sync: ReturnType<
    typeof vi.fn<(scope: Scope) => Promise<OperationResult[]>>
  >;
  repair: ReturnType<
    typeof vi.fn<(scope: Scope) => Promise<OperationResult[]>>
  >;
  uninstall: ReturnType<
    typeof vi.fn<(scope: Scope) => Promise<OperationResult[]>>
  >;
  health: ReturnType<typeof vi.fn<() => Promise<CoverageReport>>>;
}

function result(
  status: OperationResult['status'] = 'success',
  message = 'complete',
): OperationResult {
  return { status, message };
}

function fakeAdapter(id = 'codex'): FakeAdapter {
  return {
    id,
    capabilities,
    discover: vi.fn(async () => []),
    install: vi.fn(async () => [result()]),
    sync: vi.fn(async () => [result()]),
    repair: vi.fn(async () => [result()]),
    uninstall: vi.fn(async () => [result()]),
    health: vi.fn(async () => ({
      agent: id,
      skills: 'native and injected',
      mcp: 'stdio proxy',
      issues: [],
    })),
  };
}

function registryWith(...adapters: AgentAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

interface RuntimeFixture {
  runtime: Partial<CliRuntime>;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  root: string;
}

function runtimeFixture(
  overrides: Partial<CliRuntime> = {},
): RuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-usage-cli-'));
  tempDirectories.push(root);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  return {
    root,
    stdout,
    stderr,
    exitCodes,
    runtime: {
      paths: () => ({
        root,
        database: join(root, 'usage.db'),
        state: join(root, 'state'),
        errors: join(root, 'errors.log'),
      }),
      writeOutput: (text) => stdout.push(text),
      writeError: (text) => stderr.push(text),
      setExitCode: (code) => exitCodes.push(code),
      ...overrides,
    },
  };
}

async function parse(
  registry: AdapterRegistry,
  runtime: Partial<CliRuntime>,
  args: string[],
): Promise<void> {
  await createProgram(registry, runtime).parseAsync(
    ['node', 'agent-usage', ...args],
  );
}

describe('lifecycle commands', () => {
  it.each(['install', 'sync', 'repair', 'uninstall'] as const)(
    'routes %s to the selected adapter and scope',
    async (command) => {
      const adapter = fakeAdapter();
      const fixture = runtimeFixture();

      await parse(
        registryWith(adapter),
        fixture.runtime,
        [command, 'codex', '--scope', 'project'],
      );

      expect(adapter[command]).toHaveBeenCalledWith('project');
      expect(fixture.stdout.join('')).toContain('success: complete');
      expect(fixture.exitCodes).toEqual([]);
    },
  );

  it('sets a nonzero code only when a lifecycle result failed', async () => {
    const adapter = fakeAdapter();
    adapter.sync.mockResolvedValue([
      result('degraded', 'partial coverage'),
      result('failed', 'write failed'),
    ]);
    const fixture = runtimeFixture();

    await parse(
      registryWith(adapter),
      fixture.runtime,
      ['sync', 'codex', '--scope', 'user'],
    );

    expect(fixture.stdout.join('')).toContain('degraded: partial coverage');
    expect(fixture.stdout.join('')).toContain('failed: write failed');
    expect(fixture.exitCodes).toEqual([1]);
  });

  it('does not set a nonzero code for degraded or skipped results', async () => {
    const adapter = fakeAdapter();
    adapter.repair.mockResolvedValue([
      result('degraded'),
      result('skipped'),
    ]);
    const fixture = runtimeFixture();

    await parse(
      registryWith(adapter),
      fixture.runtime,
      ['repair', 'codex', '--scope', 'user'],
    );

    expect(fixture.exitCodes).toEqual([]);
  });
});

describe('report', () => {
  it('opens the local database, applies filters, renders text, and closes it', async () => {
    const fixture = runtimeFixture();
    const database = openUsageDatabase(join(fixture.root, 'usage.db'));
    const repository = new UsageRepository(database);
    repository.insert(
      usageEvent({ agent: 'codex', kind: 'skill_invocation' }),
    );
    repository.insert(
      usageEvent({ agent: 'other', kind: 'skill_invocation' }),
    );
    database.close();
    const close = vi.fn<() => void>();
    const openDatabase = vi.fn((path: string) => {
      const opened = openUsageDatabase(path);
      return {
        prepare: opened.prepare.bind(opened),
        close: () => {
          close();
          opened.close();
        },
      } as DatabaseSync;
    });
    fixture.runtime.openDatabase = openDatabase;

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      ['report', 'all', '--agent', 'codex', '--kind', 'skill_invocation'],
    );

    expect(openDatabase).toHaveBeenCalledWith(join(fixture.root, 'usage.db'));
    expect(fixture.stdout.join('')).toContain('Usage statistics — all');
    expect(fixture.stdout.join('')).toContain('codex · skill_invocation');
    expect(fixture.stdout.join('')).not.toContain('other · skill_invocation');
    expect(close).toHaveBeenCalledOnce();
  });

  it('defaults to the 7d named range', async () => {
    const fixture = runtimeFixture();

    await parse(new AdapterRegistry(), fixture.runtime, ['report']);

    expect(fixture.stdout.join('')).toContain('Usage statistics — 7d');
  });
});

describe('mcp and proxy', () => {
  it('dispatches MCP service without opening real stdio and closes the DB', async () => {
    const runMcpServer = vi.fn(async (_service: UsageMcpService) => {});
    const close = vi.fn<() => void>();
    const fixture = runtimeFixture({ runMcpServer });
    fixture.runtime.openDatabase = (path) => {
      const database = openUsageDatabase(path);
      return {
        prepare: database.prepare.bind(database),
        close: () => {
          close();
          database.close();
        },
      } as DatabaseSync;
    };

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      ['mcp', '--agent', 'codex'],
    );

    expect(runMcpServer).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('passes split command arguments, cwd/env, and child exit code to proxy', async () => {
    const proxyCalls: Array<{
      command: string;
      args: readonly string[];
      observer: StdioProtocolObserver;
      options: StdioProxyOptions;
    }> = [];
    const env = { TEST_PROXY: 'yes' };
    const runProxy: CliRuntime['runProxy'] = async (
      command,
      args,
      observer,
      options,
    ) => {
      proxyCalls.push({ command, args, observer, options: options ?? {} });
      return { code: 23, signal: null };
    };
    const fixture = runtimeFixture({
      runProxy,
      cwd: () => '/work/project',
      env,
      randomId: () => 'connection-id',
    });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      [
        'proxy',
        '--agent',
        'codex',
        '--server',
        'docs',
        '--',
        'fake-server',
        '--flag',
        'value',
      ],
    );

    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]).toMatchObject({
      command: 'fake-server',
      args: ['--flag', 'value'],
      options: { cwd: '/work/project', env },
    });
    expect(fixture.exitCodes).toEqual([23]);
  });

  it('forwards child signal semantics', async () => {
    const signalSelf = vi.fn<(signal: NodeJS.Signals) => void>();
    const fixture = runtimeFixture({
      runProxy: async () => ({ code: null, signal: 'SIGTERM' }),
      signalSelf,
    });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      ['proxy', '--agent', 'codex', '--server', 'docs', '--', 'server'],
    );

    expect(signalSelf).toHaveBeenCalledWith('SIGTERM');
    expect(fixture.exitCodes).toEqual([]);
  });

  it('uses a fail-open observer and excludes the usage self-server', async () => {
    const insert = vi.fn(() => {
      throw new Error('database unavailable');
    });
    let observer: StdioProtocolObserver | undefined;
    const fixture = runtimeFixture({
      createRepository: () => ({
        insert,
        report: () => ({
          rangeLabel: 'all',
          totals: [],
          topSkills: [],
          mcp: [],
          warnings: [],
        }),
      }),
      runProxy: async (_command, _args, value) => {
        observer = value;
        return { code: 0, signal: null };
      },
    });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      [
        'proxy',
        '--agent',
        'codex',
        '--server',
        'usage-stats',
        '--',
        'server',
      ],
    );
    observer?.observeClientChunk(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_usage"}}\n',
    );
    observer?.observeServerChunk('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    observer?.close();

    expect(insert).not.toHaveBeenCalled();
  });
});

describe('health', () => {
  it('accepts an empty registry as a valid empty state', async () => {
    const fixture = runtimeFixture();

    await parse(new AdapterRegistry(), fixture.runtime, ['health']);

    expect(fixture.stdout.join('')).toContain('No adapters registered');
    expect(fixture.exitCodes).toEqual([]);
  });

  it('checks one adapter and reports capabilities and coverage issues', async () => {
    const adapter = fakeAdapter();
    adapter.health.mockResolvedValue({
      agent: 'codex',
      skills: 'injection only',
      mcp: 'unavailable',
      issues: ['Native MCP events are unavailable'],
    });
    const fixture = runtimeFixture();

    await parse(registryWith(adapter), fixture.runtime, ['health', 'codex']);

    const output = fixture.stdout.join('');
    expect(adapter.health).toHaveBeenCalledOnce();
    expect(output).toContain('nativeSkillEvents: yes');
    expect(output).toContain('nativeMcpEvents: no');
    expect(output).toContain('Skills: injection only');
    expect(output).toContain('Native MCP events are unavailable');
  });

  it('checks all registered adapters in registration order', async () => {
    const first = fakeAdapter('first');
    const second = fakeAdapter('second');
    const fixture = runtimeFixture();

    await parse(registryWith(first, second), fixture.runtime, ['health']);

    expect(first.health).toHaveBeenCalledOnce();
    expect(second.health).toHaveBeenCalledOnce();
    expect(fixture.stdout.join('').indexOf('first')).toBeLessThan(
      fixture.stdout.join('').indexOf('second'),
    );
  });
});

describe('validation', () => {
  it.each([
    ['report', 'yesterday'],
    ['report', '--kind', 'unknown'],
    ['install', 'codex', '--scope', 'global'],
  ])('returns a clean nonzero error for %j', async (...args) => {
    const fixture = runtimeFixture();

    await runCli(
      ['node', 'agent-usage', ...args],
      registryWith(fakeAdapter()),
      fixture.runtime,
    );

    expect(fixture.exitCodes).toContain(1);
    expect(fixture.stderr.join('')).toMatch(/allowed choices|invalid/i);
    expect(fixture.stderr.join('')).not.toContain('at Command.');
  });
});

describe('uninstall purge safeguards', () => {
  it('never purges shared data without --purge-data', async () => {
    const purgeData = vi.fn<() => void>();
    const fixture = runtimeFixture({ purgeData });

    await parse(
      registryWith(fakeAdapter()),
      fixture.runtime,
      ['uninstall', 'codex', '--scope', 'user'],
    );

    expect(purgeData).not.toHaveBeenCalled();
  });

  it('refuses purge while any adapter manifest remains', async () => {
    const removed = fakeAdapter('removed');
    const installed = fakeAdapter('installed');
    installed.discover.mockResolvedValue(['/installed/manifest.json']);
    const purgeData = vi.fn<() => void>();
    const fixture = runtimeFixture({ purgeData });

    await parse(
      registryWith(removed, installed),
      fixture.runtime,
      [
        'uninstall',
        'removed',
        '--scope',
        'user',
        '--purge-data',
        '--yes',
      ],
    );

    expect(purgeData).not.toHaveBeenCalled();
    expect(fixture.stderr.join('')).toContain('/installed/manifest.json');
    expect(fixture.exitCodes).toEqual([1]);
  });

  it('requires --yes for purge in a non-TTY session', async () => {
    const purgeData = vi.fn<() => void>();
    const confirm = vi.fn(async () => true);
    const fixture = runtimeFixture({ purgeData, confirm, isTTY: () => false });

    await parse(
      registryWith(fakeAdapter()),
      fixture.runtime,
      ['uninstall', 'codex', '--scope', 'user', '--purge-data'],
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(purgeData).not.toHaveBeenCalled();
    expect(fixture.stderr.join('')).toContain('--yes');
    expect(fixture.exitCodes).toEqual([1]);
  });

  it('requires interactive confirmation and honors refusal', async () => {
    const purgeData = vi.fn<() => void>();
    const confirm = vi.fn(async () => false);
    const fixture = runtimeFixture({ purgeData, confirm, isTTY: () => true });

    await parse(
      registryWith(fakeAdapter()),
      fixture.runtime,
      ['uninstall', 'codex', '--scope', 'user', '--purge-data'],
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(purgeData).not.toHaveBeenCalled();
    expect(fixture.exitCodes).toEqual([1]);
  });

  it('purges only after explicit non-TTY confirmation with no manifests', async () => {
    const purgeData = vi.fn<() => void>();
    const fixture = runtimeFixture({ purgeData, isTTY: () => false });

    await parse(
      registryWith(fakeAdapter()),
      fixture.runtime,
      [
        'uninstall',
        'codex',
        '--scope',
        'project',
        '--purge-data',
        '--yes',
      ],
    );

    expect(purgeData).toHaveBeenCalledOnce();
  });
});
