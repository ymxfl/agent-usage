import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdapterRegistry } from '../src/adapters/registry.js';
import type {
  AgentAdapter,
  Capabilities,
  CoverageReport,
  DiscoveredTargets,
  OperationResult,
  Scope,
} from '../src/adapters/types.js';
import { createProgram, runCli, type CliRuntime } from '../src/cli.js';
import { openUsageDatabase } from '../src/core/database.js';
import { UsageRepository } from '../src/core/repository.js';
import type {
  AgentSelectionPolicy,
  SelectionConfig,
} from '../src/core/selection.js';
import type { UsageMcpService } from '../src/mcp/service.js';
import type {
  StdioProtocolObserver,
  StdioProxyOptions,
} from '../src/proxy/stdio-proxy.js';
import { runStdioProxy } from '../src/proxy/stdio-proxy.js';
import { usageEvent } from './helpers/usage-fixtures.js';

const tempDirectories: string[] = [];
const fakeMcpServer = fileURLToPath(
  new URL('./fixtures/fake-mcp-server.mjs', import.meta.url),
);

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const capabilities: Capabilities = {
  nativeSkillEvents: true,
  skillInjection: true,
  nativeMcpEvents: false,
  stdioMcpProxy: true,
  skillWatching: false,
};

interface FakeAdapter extends AgentAdapter {
  discover: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
  listTargets: ReturnType<
    typeof vi.fn<() => Promise<DiscoveredTargets>>
  >;
  configure: ReturnType<
    typeof vi.fn<
      (policy: AgentSelectionPolicy) => Promise<OperationResult[]>
    >
  >;
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

function fakeAdapter(
  id = 'codex',
  capabilityOverrides: Partial<Capabilities> = {},
): FakeAdapter {
  return {
    id,
    capabilities: { ...capabilities, ...capabilityOverrides },
    discover: vi.fn(async () => []),
    listTargets: vi.fn(async () => ({
      agent: id,
      skills: [],
      mcp: [],
      unresolved: [],
      issues: [],
    })),
    configure: vi.fn(async () => [result()]),
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
        config: join(root, 'config.json'),
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

function selectionConfig(
  agents: SelectionConfig['agents'] = {},
): SelectionConfig {
  return { version: 1, agents };
}

function mcpSelection(...mcp: string[]): AgentSelectionPolicy {
  return {
    skills: { native_hook: [], injected_mcp: [] },
    mcp,
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

const directClaudeHook = JSON.stringify({
  session_id: 'session-cli-hook',
  transcript_path: '/private/transcript.jsonl',
  cwd: '/work/payments-api',
  permission_mode: 'default',
  hook_event_name: 'UserPromptExpansion',
  expansion_type: 'slash_command',
  command_name: 'release-review',
  command_args: 'secret arguments',
  command_source: 'skill',
  prompt: 'sensitive expanded prompt',
});

describe('hidden Claude hook command', () => {
  it('lazily opens, inserts, and closes for a selected event', async () => {
    const close = vi.fn();
    const insert = vi.fn(() => true);
    const openDatabase = vi.fn<CliRuntime['openDatabase']>(() => ({ close }));
    const fixture = runtimeFixture({
      readStdin: async () => directClaudeHook,
      loadSelectionConfig: async () =>
        selectionConfig({
          'claude-code': {
            skills: {
              native_hook: ['release-review'],
              injected_mcp: [],
            },
            mcp: [],
          },
        }),
      openDatabase,
      createRepository: () => ({ insert } as never),
      appendError: vi.fn(async () => {}),
    });

    await parse(new AdapterRegistry(), fixture.runtime, ['hook', 'claude']);

    expect(openDatabase).toHaveBeenCalledWith(join(fixture.root, 'usage.db'));
    expect(insert).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.stdout).toEqual([]);
    expect(fixture.exitCodes).toEqual([]);
  });

  it.each([
    ['malformed input', '{bad json', selectionConfig()],
    ['empty policy', directClaudeHook, selectionConfig()],
  ])('keeps %s fail-open without opening the database', async (_name, input, config) => {
    const openDatabase = vi.fn<CliRuntime['openDatabase']>(() => ({
      close: vi.fn(),
    }));
    const fixture = runtimeFixture({
      readStdin: async () => input,
      loadSelectionConfig: async () => config,
      openDatabase,
      appendError: vi.fn(async () => {}),
    });

    await parse(new AdapterRegistry(), fixture.runtime, ['hook', 'claude']);

    expect(openDatabase).not.toHaveBeenCalled();
    expect(fixture.stdout).toEqual([]);
    expect(fixture.exitCodes).toEqual([]);
  });

  it.each(['open', 'repository', 'insert'])('swallows %s failures', async (failure) => {
    const database = { close: vi.fn() };
    const fixture = runtimeFixture({
      readStdin: async () => directClaudeHook,
      loadSelectionConfig: async () =>
        selectionConfig({
          'claude-code': {
            skills: {
              native_hook: ['release-review'],
              injected_mcp: [],
            },
            mcp: [],
          },
        }),
      openDatabase: () => {
        if (failure === 'open') throw new Error('open failed');
        return database;
      },
      createRepository: () => {
        if (failure === 'repository') throw new Error('repository failed');
        return {
          insert: () => {
            if (failure === 'insert') throw new Error('insert failed');
            return true;
          },
        } as never;
      },
      appendError: vi.fn(async () => {}),
    });

    await expect(
      parse(new AdapterRegistry(), fixture.runtime, ['hook', 'claude']),
    ).resolves.toBeUndefined();
    expect(fixture.stdout).toEqual([]);
    expect(fixture.exitCodes).toEqual([]);
  });

  it('swallows and logs database close failures', async () => {
    const appendError = vi.fn(async () => {});
    const fixture = runtimeFixture({
      readStdin: async () => directClaudeHook,
      loadSelectionConfig: async () =>
        selectionConfig({
          'claude-code': {
            skills: {
              native_hook: ['release-review'],
              injected_mcp: [],
            },
            mcp: [],
          },
        }),
      openDatabase: () => ({
        close: () => {
          throw new Error('close failed');
        },
      }),
      createRepository: () => ({ insert: () => true } as never),
      appendError,
    });

    await expect(
      parse(new AdapterRegistry(), fixture.runtime, ['hook', 'claude']),
    ).resolves.toBeUndefined();
    expect(appendError).toHaveBeenCalledWith(
      join(fixture.root, 'errors.log'),
      expect.stringContaining('Failed to close Claude hook database'),
    );
    expect(fixture.stdout).toEqual([]);
    expect(fixture.exitCodes).toEqual([]);
  });

  it('uses the default best-effort error appender with parent creation', async () => {
    const fixture = runtimeFixture({
      paths: () => ({
        root: fixture.root,
        config: join(fixture.root, 'config.json'),
        database: join(fixture.root, 'usage.db'),
        state: join(fixture.root, 'state'),
        errors: join(fixture.root, 'nested', 'logs', 'errors.log'),
      }),
      readStdin: async () => '{bad json',
    });

    await parse(new AdapterRegistry(), fixture.runtime, ['hook', 'claude']);

    expect(
      readFileSync(join(fixture.root, 'nested', 'logs', 'errors.log'), 'utf8'),
    ).toContain('Failed to consume Claude hook');
    expect(fixture.stdout).toEqual([]);
    expect(fixture.exitCodes).toEqual([]);
  });
});

describe('target selection commands', () => {
  it('lists user and project Skills and MCP for only the selected adapter', async () => {
    const other = fakeAdapter('other');
    const adapter = fakeAdapter();
    adapter.listTargets.mockResolvedValue({
      agent: 'codex',
      skills: [
        {
          name: 'review',
          scope: 'user',
          path: '/user/skills/review',
          supportedModes: ['native_hook'],
          selectedMode: 'native_hook',
        },
        {
          name: 'deploy',
          scope: 'project',
          path: '/project/skills/deploy',
          supportedModes: ['injected_mcp'],
        },
      ],
      mcp: [
        {
          server: 'github',
          scope: 'user',
          transport: 'stdio',
          selected: true,
        },
        {
          server: 'docs',
          scope: 'project',
          transport: 'http',
        },
      ],
      unresolved: ['missing-*'],
      issues: ['docs uses an unsupported transport'],
    });
    const fixture = runtimeFixture();

    await parse(
      registryWith(other, adapter),
      fixture.runtime,
      ['list-targets', 'codex'],
    );

    expect(adapter.listTargets).toHaveBeenCalledOnce();
    expect(other.listTargets).not.toHaveBeenCalled();
    expect(fixture.stdout.join('')).toBe(
      'codex\n' +
        '  Skills:\n' +
        '  - review [user] native_hook (selected: native_hook) /user/skills/review\n' +
        '  - deploy [project] injected_mcp (selected: none) /project/skills/deploy\n' +
        '  MCP:\n' +
        '  - github [user] stdio (selected: yes)\n' +
        '  - docs [project] http (selected: no)\n' +
        '  Unresolved patterns:\n' +
        '  - missing-*\n' +
        '  Issues:\n' +
        '  - docs uses an unsupported transport\n',
    );
  });

  it('prints an explicit empty target state', async () => {
    const fixture = runtimeFixture();

    await parse(
      registryWith(fakeAdapter()),
      fixture.runtime,
      ['list-targets', 'codex'],
    );

    expect(fixture.stdout.join('')).toBe(
      'codex\n' +
        '  No targets discovered.\n' +
        '  Skills: none\n' +
        '  MCP: none\n' +
        '  Unresolved patterns: none\n' +
        '  Issues: none\n',
    );
  });

  it('builds a replacement policy from repeated selectors and deduplicates exact repeats', async () => {
    const adapter = fakeAdapter();
    const fixture = runtimeFixture();

    await parse(registryWith(adapter), fixture.runtime, [
      'configure',
      'codex',
      '--native-skill',
      'review',
      '--native-skill',
      'review',
      '--native-skill',
      'test-*',
      '--inject-skill',
      'deploy',
      '--inject-skill',
      'deploy',
      '--mcp',
      'github.*',
      '--mcp',
      'github.*',
    ]);

    expect(adapter.configure).toHaveBeenCalledWith({
      skills: {
        native_hook: ['review', 'test-*'],
        injected_mcp: ['deploy'],
      },
      mcp: ['github.*'],
    });
    expect(fixture.stdout.join('')).toContain(
      'Desired policy:\n' +
        '  Skills (native_hook): review, test-*\n' +
        '  Skills (injected_mcp): deploy\n' +
        '  MCP: github.*\n',
    );
  });

  it('clears all selections when configure has no options', async () => {
    const adapter = fakeAdapter();
    const fixture = runtimeFixture();

    await parse(
      registryWith(adapter),
      fixture.runtime,
      ['configure', 'codex'],
    );

    expect(adapter.configure).toHaveBeenCalledWith({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: [],
    });
    expect(fixture.stdout.join('')).toContain(
      'Skills (native_hook): none\n' +
        '  Skills (injected_mcp): none\n' +
        '  MCP: none\n',
    );
  });

  it.each(['native_hook', 'injected_mcp'] as const)(
    'supports --all-skills %s together with --all-mcp',
    async (mode) => {
      const adapter = fakeAdapter();
      const fixture = runtimeFixture();

      await parse(registryWith(adapter), fixture.runtime, [
        'configure',
        'codex',
        '--all-skills',
        mode,
        '--all-mcp',
      ]);

      expect(adapter.configure).toHaveBeenCalledWith({
        skills: {
          native_hook: mode === 'native_hook' ? ['*'] : [],
          injected_mcp: mode === 'injected_mcp' ? ['*'] : [],
        },
        mcp: ['*'],
      });
    },
  );

  it.each([
    {
      name: 'native_hook',
      capabilities: { nativeSkillEvents: false },
      args: ['--native-skill', 'review'],
    },
    {
      name: 'injected_mcp',
      capabilities: { skillInjection: false },
      args: ['--inject-skill', 'review'],
    },
    {
      name: 'MCP selection',
      capabilities: { nativeMcpEvents: false, stdioMcpProxy: false },
      args: ['--mcp', 'github'],
    },
  ])('rejects unsupported $name without configuring', async (testCase) => {
    const adapter = fakeAdapter('codex', testCase.capabilities);
    const fixture = runtimeFixture();

    await runCli(
      ['node', 'agent-usage', 'configure', 'codex', ...testCase.args],
      registryWith(adapter),
      fixture.runtime,
    );

    expect(adapter.configure).not.toHaveBeenCalled();
    expect(fixture.exitCodes).toContain(1);
    expect(fixture.stderr.join('')).toMatch(/does not support/i);
    expect(fixture.stderr.join('')).not.toContain('at Command.');
  });

  it('rejects a selected mode unsupported by the discovered Skill', async () => {
    const adapter = fakeAdapter();
    adapter.listTargets.mockResolvedValue({
      agent: 'codex',
      skills: [{
        name: 'read-only-review',
        scope: 'user',
        path: '/skills/read-only-review',
        supportedModes: ['native_hook'],
      }],
      mcp: [],
      unresolved: [],
      issues: [],
    });
    const fixture = runtimeFixture();

    await runCli(
      [
        'node',
        'agent-usage',
        'configure',
        'codex',
        '--inject-skill',
        'read-only-*',
      ],
      registryWith(adapter),
      fixture.runtime,
    );

    expect(adapter.configure).not.toHaveBeenCalled();
    expect(fixture.stderr.join('')).toContain(
      'Skill "read-only-review" does not support injected_mcp',
    );
    expect(fixture.exitCodes).toContain(1);
  });

  it.each([
    'remote',
    'remote.*',
    '*.search',
    '*search',
    '*',
    'rem*ch',
  ])(
    'rejects proxy-only selection %s for a discovered HTTP MCP server',
    async (pattern) => {
      const adapter = fakeAdapter();
      adapter.listTargets.mockResolvedValue({
        agent: 'codex',
        skills: [],
        mcp: [{
          server: 'remote',
          scope: 'project',
          transport: 'http',
        }],
        unresolved: [],
        issues: [],
      });
      const fixture = runtimeFixture();

      await runCli(
        [
          'node',
          'agent-usage',
          'configure',
          'codex',
          '--mcp',
          pattern,
        ],
        registryWith(adapter),
        fixture.runtime,
      );

      expect(adapter.configure).not.toHaveBeenCalled();
      expect(fixture.stderr.join('')).toContain(
        'MCP server "remote" uses http, which requires native MCP events',
      );
      expect(fixture.exitCodes).toContain(1);
    },
  );

  it('leaves an unrelated future MCP pattern to the adapter', async () => {
    const adapter = fakeAdapter();
    adapter.listTargets.mockResolvedValue({
      agent: 'codex',
      skills: [],
      mcp: [{
        server: 'remote',
        scope: 'project',
        transport: 'http',
      }],
      unresolved: [],
      issues: [],
    });
    const fixture = runtimeFixture();

    await parse(registryWith(adapter), fixture.runtime, [
      'configure',
      'codex',
      '--mcp',
      'local.*',
    ]);

    expect(adapter.configure).toHaveBeenCalledWith({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: ['local.*'],
    });
  });

  it('allows a selected discovered HTTP MCP server with native MCP events', async () => {
    const adapter = fakeAdapter('codex', {
      nativeMcpEvents: true,
      stdioMcpProxy: false,
    });
    adapter.listTargets.mockResolvedValue({
      agent: 'codex',
      skills: [],
      mcp: [{
        server: 'remote',
        scope: 'project',
        transport: 'http',
      }],
      unresolved: [],
      issues: [],
    });
    const fixture = runtimeFixture();

    await parse(registryWith(adapter), fixture.runtime, [
      'configure',
      'codex',
      '--mcp',
      'remote.*',
    ]);

    expect(adapter.configure).toHaveBeenCalledWith({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: ['remote.*'],
    });
    expect(fixture.exitCodes).toEqual([]);
  });

  it.each(['--native-skill', '--inject-skill', '--mcp'])(
    'rejects an exact-empty pattern for %s before adapter discovery',
    async (option) => {
      const adapter = fakeAdapter();
      const fixture = runtimeFixture();

      await runCli(
        ['node', 'agent-usage', 'configure', 'codex', option, ''],
        registryWith(adapter),
        fixture.runtime,
      );

      expect(adapter.listTargets).not.toHaveBeenCalled();
      expect(adapter.configure).not.toHaveBeenCalled();
      expect(fixture.exitCodes).toContain(1);
      expect(fixture.stderr.join('')).toMatch(/must not be empty/i);
      expect(fixture.stderr.join('')).not.toContain('at Command.');
    },
  );

  it.each([
    ['--all-skills', 'native_hook', '--native-skill', 'review'],
    ['--all-skills', 'injected_mcp', '--inject-skill', 'review'],
    ['--all-mcp', '--mcp', 'github'],
  ])('rejects all-target and explicit selector conflicts: %j', async (...args) => {
    const adapter = fakeAdapter();
    const fixture = runtimeFixture();

    await runCli(
      ['node', 'agent-usage', 'configure', 'codex', ...args],
      registryWith(adapter),
      fixture.runtime,
    );

    expect(adapter.configure).not.toHaveBeenCalled();
    expect(fixture.exitCodes).toContain(1);
    expect(fixture.stderr.join('')).toMatch(/cannot combine/i);
    expect(fixture.stderr.join('')).not.toContain('at Command.');
  });

  it('rejects a discovered Skill matched by both modes before configuring', async () => {
    const adapter = fakeAdapter();
    adapter.listTargets.mockResolvedValue({
      agent: 'codex',
      skills: [{
        name: 'review-prod',
        scope: 'project',
        path: '/project/review-prod',
        supportedModes: ['native_hook', 'injected_mcp'],
      }],
      mcp: [],
      unresolved: [],
      issues: [],
    });
    const fixture = runtimeFixture();

    await runCli(
      [
        'node',
        'agent-usage',
        'configure',
        'codex',
        '--native-skill',
        'review-*',
        '--inject-skill',
        '*-prod',
      ],
      registryWith(adapter),
      fixture.runtime,
    );

    expect(adapter.listTargets).toHaveBeenCalledOnce();
    expect(adapter.configure).not.toHaveBeenCalled();
    expect(fixture.stderr.join('')).toContain(
      'Skill "review-prod" matches both native_hook and injected_mcp',
    );
    expect(fixture.exitCodes).toContain(1);
  });

  it.each([
    ['failed', [1]],
    ['degraded', []],
  ] as const)('handles a %s configure result', async (status, exitCodes) => {
    const adapter = fakeAdapter();
    adapter.configure.mockResolvedValue([result(status)]);
    const fixture = runtimeFixture();

    await parse(
      registryWith(adapter),
      fixture.runtime,
      ['configure', 'codex', '--native-skill', 'review'],
    );

    expect(fixture.stdout.join('')).toContain(`${status}: complete`);
    expect(fixture.exitCodes).toEqual(exitCodes);
  });

  it.each(['list-targets', 'configure'])(
    'reports an unknown agent cleanly for %s',
    async (command) => {
      const fixture = runtimeFixture();

      await runCli(
        ['node', 'agent-usage', command, 'missing'],
        registryWith(fakeAdapter()),
        fixture.runtime,
      );

      expect(fixture.exitCodes).toContain(1);
      expect(fixture.stderr.join('')).toContain('Unknown adapter "missing"');
      expect(fixture.stderr.join('')).not.toContain('at Command.');
    },
  );
});

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

  it.each(['install', 'sync', 'repair', 'uninstall'] as const)(
    'defaults %s to user scope',
    async (command) => {
      const adapter = fakeAdapter();
      const fixture = runtimeFixture();

      await parse(registryWith(adapter), fixture.runtime, [command, 'codex']);

      expect(adapter[command]).toHaveBeenCalledWith('user');
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

  it.each([
    ['missing', undefined],
    ['empty', async () => selectionConfig()],
  ] as const)(
    '%s policy launches the proxy without opening telemetry storage',
    async (_case, loadSelectionConfig) => {
      const openDatabase = vi.fn<CliRuntime['openDatabase']>(() => ({
        close: vi.fn(),
      }));
      const insert = vi.fn();
      const runProxy = vi.fn<CliRuntime['runProxy']>(async (
        _command,
        _args,
        observer,
      ) => {
        observer.observeClientChunk(
          '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search"}}\n',
        );
        observer.observeServerChunk(
          '{"jsonrpc":"2.0","id":1,"result":{}}\n',
        );
        return { code: 0, signal: null };
      });
      const fixture = runtimeFixture({
        openDatabase,
        createRepository: () => ({ insert, report: vi.fn() }),
        runProxy,
        ...(loadSelectionConfig === undefined ? {} : { loadSelectionConfig }),
      });

      await parse(
        new AdapterRegistry(),
        fixture.runtime,
        ['proxy', '--agent', 'codex', '--server', 'github', '--', 'server'],
      );

      expect(runProxy).toHaveBeenCalledOnce();
      expect(openDatabase).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it('records only a selected qualified tool while relaying both exchanges unchanged', async () => {
    const requests = [
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search"}}\n',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write"}}\n',
    ].join('');
    const responses = [
      '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}\n',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}]}}\n',
    ].join('');
    const output: string[] = [];
    const insert = vi.fn();
    const close = vi.fn();
    const loadSelectionConfig = vi.fn(async () =>
      selectionConfig({ codex: mcpSelection('github.search') })
    );
    const fixture = runtimeFixture({
      loadSelectionConfig,
      openDatabase: () => ({ close }),
      createRepository: () => ({ insert, report: vi.fn() }),
      runProxy: (command, args, observer, options) =>
        runStdioProxy(command, args, observer, {
          ...options,
          input: Readable.from([requests]),
          output: new Writable({
            write(chunk, _encoding, callback) {
              output.push(chunk.toString());
              callback();
            },
          }),
          error: new PassThrough(),
        }),
    });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      [
        'proxy',
        '--agent',
        'codex',
        '--server',
        'github',
        '--',
        process.execPath,
        fakeMcpServer,
        'protocol',
      ],
    );

    expect(output.join('')).toBe(responses);
    expect(loadSelectionConfig).toHaveBeenCalledOnce();
    expect(loadSelectionConfig).toHaveBeenCalledWith(
      join(fixture.root, 'config.json'),
    );
    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        kind: 'mcp_call',
        mcpServer: 'github',
        name: 'search',
        outcome: 'success',
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('records every tool for a selected MCP server', async () => {
    const insert = vi.fn();
    let observer: StdioProtocolObserver | undefined;
    const fixture = runtimeFixture({
      loadSelectionConfig: async () =>
        selectionConfig({ codex: mcpSelection('github') }),
      createRepository: () => ({ insert, report: vi.fn() }),
      runProxy: async (_command, _args, value) => {
        observer = value;
        return { code: 0, signal: null };
      },
    });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      ['proxy', '--agent', 'codex', '--server', 'github', '--', 'server'],
    );
    for (const [id, name] of [[1, 'search'], [2, 'write']] as const) {
      observer?.observeClientChunk(
        `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"${name}"}}\n`,
      );
      observer?.observeServerChunk(
        `{"jsonrpc":"2.0","id":${id},"result":{}}\n`,
      );
    }

    expect(insert.mock.calls.map(([event]) => event.name)).toEqual([
      'search',
      'write',
    ]);
  });

  it('ignores policy belonging to another agent', async () => {
    const openDatabase = vi.fn<CliRuntime['openDatabase']>(() => ({
      close: vi.fn(),
    }));
    const runProxy = vi.fn<CliRuntime['runProxy']>(async () => ({
      code: 0,
      signal: null,
    }));
    const fixture = runtimeFixture({
      loadSelectionConfig: async () =>
        selectionConfig({ other: mcpSelection('github') }),
      openDatabase,
      runProxy,
    });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      ['proxy', '--agent', 'codex', '--server', 'github', '--', 'server'],
    );

    expect(runProxy).toHaveBeenCalledOnce();
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it.each(['path failure', 'malformed policy', 'read failure'])(
    '%s logs and preserves the child exit',
    async (failure) => {
      const logger = { error: vi.fn() };
      const openDatabase = vi.fn<CliRuntime['openDatabase']>(() => ({
        close: vi.fn(),
      }));
      const fixture = runtimeFixture({
        loadSelectionConfig: async () => {
          throw new Error(failure);
        },
        openDatabase,
        logger,
        runProxy: async () => ({ code: 19, signal: null }),
      });
      if (failure === 'path failure') {
        fixture.runtime.paths = () => {
          throw new Error(failure);
        };
      }

      await parse(
        new AdapterRegistry(),
        fixture.runtime,
        ['proxy', '--agent', 'codex', '--server', 'github', '--', 'server'],
      );

      expect(openDatabase).not.toHaveBeenCalled();
      expect(fixture.exitCodes).toEqual([19]);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to initialize proxy telemetry',
        expect.objectContaining({ message: failure }),
      );
    },
  );

  it('forwards child flags without an explicit option separator', async () => {
    const runProxy = vi.fn<CliRuntime['runProxy']>(async () => ({
      code: 0,
      signal: null,
    }));
    const fixture = runtimeFixture({ runProxy });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      [
        'proxy',
        '--agent',
        'codex',
        '--server',
        'docs',
        'fake-server',
        '--child-flag',
        'value',
        '-x',
      ],
    );

    expect(runProxy).toHaveBeenCalledWith(
      'fake-server',
      ['--child-flag', 'value', '-x'],
      expect.anything(),
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it('launches and relays the child when telemetry storage cannot open', async () => {
    const output: string[] = [];
    const logger = { error: vi.fn() };
    const fixture = runtimeFixture({
      loadSelectionConfig: async () =>
        selectionConfig({ codex: mcpSelection('docs') }),
      openDatabase: () => {
        throw new Error('storage unavailable');
      },
      logger,
      runProxy: (command, args, observer, options) =>
        runStdioProxy(command, args, observer, {
          ...options,
          input: Readable.from([]),
          output: new Writable({
            write(chunk, _encoding, callback) {
              output.push(chunk.toString());
              callback();
            },
          }),
          error: new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
        }),
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
        process.execPath,
        '-e',
        'process.stdout.write("child survived\\n"); process.exit(7)',
      ],
    );

    expect(output.join('')).toBe('child survived\n');
    expect(fixture.exitCodes).toEqual([7]);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to initialize proxy telemetry',
      expect.objectContaining({ message: 'storage unavailable' }),
    );
  });

  it.each(['database', 'repository'] as const)(
    'still dispatches proxy when %s telemetry initialization fails',
    async (failure) => {
      const runProxy = vi.fn<CliRuntime['runProxy']>(async () => ({
        code: 0,
        signal: null,
      }));
      const close = vi.fn();
      const fixture = runtimeFixture({
        runProxy,
        logger: { error: vi.fn() },
        openDatabase: () => ({ close }),
        loadSelectionConfig: async () =>
          selectionConfig({ codex: mcpSelection('docs') }),
      });
      if (failure === 'database') {
        fixture.runtime.openDatabase = () => {
          throw new Error('database unavailable');
        };
      } else {
        fixture.runtime.createRepository = () => {
          throw new Error('repository unavailable');
        };
      }

      await parse(
        new AdapterRegistry(),
        fixture.runtime,
        ['proxy', '--agent', 'codex', '--server', 'docs', '--', 'server'],
      );

      expect(runProxy).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledTimes(failure === 'repository' ? 1 : 0);
    },
  );

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
      loadSelectionConfig: async () =>
        selectionConfig({ codex: mcpSelection('usage-stats') }),
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

  it('keeps the child successful when a selected insert and its logger fail', async () => {
    const close = vi.fn();
    const fixture = runtimeFixture({
      loadSelectionConfig: async () =>
        selectionConfig({ codex: mcpSelection('github.search') }),
      openDatabase: () => ({ close }),
      createRepository: () => ({
        insert: () => {
          throw new Error('insert failed');
        },
        report: vi.fn(),
      }),
      logger: {
        error: () => {
          throw new Error('logger failed');
        },
      },
      runProxy: async (_command, _args, observer) => {
        observer.observeClientChunk(
          '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search"}}\n',
        );
        observer.observeServerChunk(
          '{"jsonrpc":"2.0","id":1,"result":{}}\n',
        );
        return { code: 0, signal: null };
      },
    });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      ['proxy', '--agent', 'codex', '--server', 'github', '--', 'server'],
    );

    expect(fixture.exitCodes).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves the child exit when closing selected telemetry fails', async () => {
    const logger = { error: vi.fn() };
    const fixture = runtimeFixture({
      loadSelectionConfig: async () =>
        selectionConfig({ codex: mcpSelection('github') }),
      openDatabase: () => ({
        close: () => {
          throw new Error('close failed');
        },
      }),
      createRepository: () => ({ insert: vi.fn(), report: vi.fn() }),
      logger,
      runProxy: async () => ({ code: 17, signal: null }),
    });

    await parse(
      new AdapterRegistry(),
      fixture.runtime,
      ['proxy', '--agent', 'codex', '--server', 'github', '--', 'server'],
    );

    expect(fixture.exitCodes).toEqual([17]);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to close proxy telemetry',
      expect.objectContaining({ message: 'close failed' }),
    );
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

  it('accepts -y as explicit non-TTY purge confirmation', async () => {
    const purgeData = vi.fn<() => void>();
    const fixture = runtimeFixture({ purgeData, isTTY: () => false });

    await parse(
      registryWith(fakeAdapter()),
      fixture.runtime,
      [
        'uninstall',
        'codex',
        '--scope',
        'user',
        '--purge-data',
        '-y',
      ],
    );

    expect(purgeData).toHaveBeenCalledOnce();
  });
});
