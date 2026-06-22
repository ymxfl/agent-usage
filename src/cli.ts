import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  Command,
  CommanderError,
  InvalidArgumentError,
} from 'commander';

import { AdapterRegistry } from './adapters/registry.js';
import type {
  AgentAdapter,
  Capabilities,
  DiscoveredTargets,
  OperationResult,
  Scope,
} from './adapters/types.js';
import { openUsageDatabase } from './core/database.js';
import type { UsageEvent } from './core/event.js';
import { usagePaths, type UsagePaths } from './core/paths.js';
import {
  namedRangeStart,
  type NamedRange,
  type QueryFilter,
  type UsageReport,
} from './core/query.js';
import { UsageRepository } from './core/repository.js';
import {
  matchSelectionPattern,
  selectedSkillMode,
  skillModes,
  type AgentSelectionPolicy,
  type SkillMode,
} from './core/selection.js';
import { runUsageMcpServer } from './mcp/server.js';
import {
  UsageMcpService,
  type UsageMcpRepository,
} from './mcp/service.js';
import {
  McpProtocolObserver,
  type McpProtocolLogger,
} from './proxy/protocol.js';
import {
  runStdioProxy,
  type StdioProtocolObserver,
  type StdioProxyOptions,
  type StdioProxyResult,
} from './proxy/stdio-proxy.js';
import { renderUsageReportText } from './report/text.js';

export interface CliDatabase {
  close(): void;
}

export interface CliRepository extends UsageMcpRepository {
  report(filter: QueryFilter, rangeLabel: string): UsageReport;
}

export interface CliRuntime {
  paths(): UsagePaths;
  openDatabase(path: string): CliDatabase;
  createRepository(database: CliDatabase): CliRepository;
  runMcpServer(service: UsageMcpService): Promise<void>;
  runProxy(
    command: string,
    args: readonly string[],
    observer: StdioProtocolObserver,
    options?: StdioProxyOptions,
  ): Promise<StdioProxyResult>;
  cwd(): string;
  env: NodeJS.ProcessEnv;
  randomId(): string;
  writeOutput(text: string): void;
  writeError(text: string): void;
  setExitCode(code: number): void;
  signalSelf(signal: NodeJS.Signals): void;
  isTTY(): boolean;
  confirm(message: string): Promise<boolean>;
  purgeData(paths: UsagePaths): void;
  logger: McpProtocolLogger;
}

const namedRanges = ['today', '7d', '30d', 'all'] as const;
const eventKinds = [
  'skill_session_load',
  'skill_invocation',
  'mcp_call',
] as const;
const scopes = ['user', 'project'] as const;

function defaultRuntime(): CliRuntime {
  return {
    paths: usagePaths,
    openDatabase: openUsageDatabase,
    createRepository: (database) =>
      new UsageRepository(database as DatabaseSync),
    runMcpServer: runUsageMcpServer,
    runProxy: runStdioProxy,
    cwd: () => process.cwd(),
    env: process.env,
    randomId: randomUUID,
    writeOutput: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    signalSelf: (signal) => {
      process.kill(process.pid, signal);
    },
    isTTY: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
    confirm: async (message) => {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await prompt.question(`${message} [y/N] `);
        return /^(?:y|yes)$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    },
    purgeData: (paths) => rmSync(paths.root, { recursive: true, force: true }),
    logger: console,
  };
}

function resolveRuntime(overrides: Partial<CliRuntime>): CliRuntime {
  return { ...defaultRuntime(), ...overrides };
}

function choice<T extends string>(
  value: string,
  values: readonly T[],
  label: string,
): T {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new InvalidArgumentError(
    `invalid ${label} "${value}". Allowed choices are ${values.join(', ')}.`,
  );
}

function selectedAdapter(
  command: Command,
  registry: AdapterRegistry,
  id: string,
): AgentAdapter {
  try {
    return registry.get(id);
  } catch (error) {
    command.error(error instanceof Error ? error.message : String(error));
  }
}

function printResults(
  results: OperationResult[],
  runtime: CliRuntime,
): boolean {
  for (const result of results) {
    const path = result.path === undefined ? '' : ` (${result.path})`;
    runtime.writeOutput(`${result.status}: ${result.message}${path}\n`);
  }
  return results.some((result) => result.status === 'failed');
}

function printCapabilities(
  capabilities: Capabilities,
  runtime: CliRuntime,
): void {
  for (const [name, supported] of Object.entries(capabilities)) {
    runtime.writeOutput(`  ${name}: ${supported ? 'yes' : 'no'}\n`);
  }
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function targetSortKey(scope: Scope, name: string, detail: string): string {
  return `${scope === 'user' ? '0' : '1'}\0${name}\0${detail}`;
}

function printTargets(
  targets: DiscoveredTargets,
  runtime: CliRuntime,
): void {
  runtime.writeOutput(`${targets.agent}\n`);
  if (targets.skills.length === 0 && targets.mcp.length === 0) {
    runtime.writeOutput('  No targets discovered.\n');
  }

  if (targets.skills.length === 0) {
    runtime.writeOutput('  Skills: none\n');
  } else {
    runtime.writeOutput('  Skills:\n');
    const skills = [...targets.skills].sort((left, right) =>
      compareText(
        targetSortKey(left.scope, left.name, left.path),
        targetSortKey(right.scope, right.name, right.path),
      )
    );
    for (const skill of skills) {
      const modes = skill.supportedModes.length === 0
        ? 'none'
        : [...skill.supportedModes].sort(compareText).join(', ');
      runtime.writeOutput(
        `  - ${skill.name} [${skill.scope}] ${modes} (selected: ${skill.selectedMode ?? 'none'}) ${skill.path}\n`,
      );
    }
  }

  if (targets.mcp.length === 0) {
    runtime.writeOutput('  MCP: none\n');
  } else {
    runtime.writeOutput('  MCP:\n');
    const servers = [...targets.mcp].sort((left, right) =>
      compareText(
        targetSortKey(left.scope, left.server, left.transport),
        targetSortKey(right.scope, right.server, right.transport),
      )
    );
    for (const server of servers) {
      runtime.writeOutput(
        `  - ${server.server} [${server.scope}] ${server.transport} (selected: ${server.selected === true ? 'yes' : 'no'})\n`,
      );
    }
  }

  if (targets.unresolved.length === 0) {
    runtime.writeOutput('  Unresolved patterns: none\n');
  } else {
    runtime.writeOutput('  Unresolved patterns:\n');
    for (const pattern of [...targets.unresolved].sort(compareText)) {
      runtime.writeOutput(`  - ${pattern}\n`);
    }
  }

  if (targets.issues.length === 0) {
    runtime.writeOutput('  Issues: none\n');
  } else {
    runtime.writeOutput('  Issues:\n');
    for (const issue of [...targets.issues].sort(compareText)) {
      runtime.writeOutput(`  - ${issue}\n`);
    }
  }
}

function printSelectionPolicy(
  policy: AgentSelectionPolicy,
  runtime: CliRuntime,
): void {
  const display = (patterns: string[]): string =>
    patterns.length === 0 ? 'none' : patterns.join(', ');
  runtime.writeOutput('Desired policy:\n');
  runtime.writeOutput(
    `  Skills (native_hook): ${display(policy.skills.native_hook)}\n`,
  );
  runtime.writeOutput(
    `  Skills (injected_mcp): ${display(policy.skills.injected_mcp)}\n`,
  );
  runtime.writeOutput(`  MCP: ${display(policy.mcp)}\n`);
}

function collectOption(value: string, previous: string[]): string[] {
  return previous.includes(value) ? previous : [...previous, value];
}

interface ConfigureOptions {
  nativeSkill: string[];
  injectSkill: string[];
  mcp: string[];
  allSkills?: SkillMode;
  allMcp?: boolean;
}

function desiredSelectionPolicy(
  command: Command,
  adapter: AgentAdapter,
  options: ConfigureOptions,
): AgentSelectionPolicy {
  const hasExplicitSkill =
    options.nativeSkill.length > 0 || options.injectSkill.length > 0;
  if (options.allSkills !== undefined && hasExplicitSkill) {
    command.error(
      'Cannot combine --all-skills with --native-skill or --inject-skill.',
    );
  }
  if (options.allMcp === true && options.mcp.length > 0) {
    command.error('Cannot combine --all-mcp with --mcp.');
  }

  const nativeHook = options.allSkills === 'native_hook'
    ? ['*']
    : options.nativeSkill;
  const injectedMcp = options.allSkills === 'injected_mcp'
    ? ['*']
    : options.injectSkill;
  const mcp = options.allMcp === true ? ['*'] : options.mcp;

  if (nativeHook.length > 0 && !adapter.capabilities.nativeSkillEvents) {
    command.error(`Adapter "${adapter.id}" does not support native_hook Skills.`);
  }
  if (injectedMcp.length > 0 && !adapter.capabilities.skillInjection) {
    command.error(
      `Adapter "${adapter.id}" does not support injected_mcp Skills.`,
    );
  }
  if (
    mcp.length > 0 &&
    !adapter.capabilities.nativeMcpEvents &&
    !adapter.capabilities.stdioMcpProxy
  ) {
    command.error(`Adapter "${adapter.id}" does not support MCP selection.`);
  }

  return {
    skills: { native_hook: nativeHook, injected_mcp: injectedMcp },
    mcp,
  };
}

function selectsMcpServer(
  policy: AgentSelectionPolicy,
  server: string,
): boolean {
  return policy.mcp.some((pattern) => {
    if (matchSelectionPattern(pattern, server)) return true;

    let separator = pattern.indexOf('.');
    while (separator >= 0) {
      const serverPattern = pattern.slice(0, separator);
      if (
        serverPattern.length > 0 &&
        matchSelectionPattern(serverPattern, server)
      ) {
        return true;
      }
      separator = pattern.indexOf('.', separator + 1);
    }
    return false;
  });
}

function logTelemetryError(
  runtime: CliRuntime,
  message: string,
  error: unknown,
): void {
  try {
    runtime.logger.error(message, error);
  } catch {
    // Telemetry diagnostics must never interfere with the proxied child.
  }
}

function initializeProxyTelemetry(
  runtime: CliRuntime,
  agent: string,
  server: string,
): { database: CliDatabase | undefined; observer: McpProtocolObserver } {
  let database: CliDatabase | undefined;
  let emit: (event: UsageEvent) => unknown = () => false;

  try {
    database = runtime.openDatabase(runtime.paths().database);
    const repository = runtime.createRepository(database);
    emit = (event) => repository.insert(event);
  } catch (error) {
    logTelemetryError(runtime, 'Failed to initialize proxy telemetry', error);
  }

  return {
    database,
    observer: new McpProtocolObserver(
      agent,
      server,
      runtime.randomId(),
      emit,
      runtime.logger,
    ),
  };
}

function closeProxyTelemetry(
  runtime: CliRuntime,
  database: CliDatabase | undefined,
): void {
  try {
    database?.close();
  } catch (error) {
    logTelemetryError(runtime, 'Failed to close proxy telemetry', error);
  }
}

async function remainingManifests(
  registry: AdapterRegistry,
): Promise<string[]> {
  const discovered = await Promise.all(
    registry.list().map((adapter) => adapter.discover()),
  );
  return discovered.flat();
}

async function maybePurgeData(
  registry: AdapterRegistry,
  runtime: CliRuntime,
  options: { purgeData?: boolean; yes?: boolean },
): Promise<void> {
  if (options.purgeData !== true) return;

  let manifests: string[];
  try {
    manifests = await remainingManifests(registry);
  } catch (error) {
    runtime.writeError(
      `Refusing to purge shared data because adapter discovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    runtime.setExitCode(1);
    return;
  }

  if (manifests.length > 0) {
    runtime.writeError(
      `Refusing to purge shared data while adapter manifests remain:\n${manifests.map((path) => `- ${path}`).join('\n')}\n`,
    );
    runtime.setExitCode(1);
    return;
  }

  if (options.yes !== true) {
    if (!runtime.isTTY()) {
      runtime.writeError(
        'Refusing to purge shared data in a non-TTY session without --yes.\n',
      );
      runtime.setExitCode(1);
      return;
    }
    if (!(await runtime.confirm('Delete the shared usage database and state?'))) {
      runtime.writeError('Shared data purge cancelled.\n');
      runtime.setExitCode(1);
      return;
    }
  }

  runtime.purgeData(runtime.paths());
  runtime.writeOutput('success: purged shared usage data\n');
}

function addLifecycleCommand(
  program: Command,
  registry: AdapterRegistry,
  runtime: CliRuntime,
  operation: 'install' | 'sync' | 'repair',
): void {
  program
    .command(`${operation} <agent>`)
    .option(
      '--scope <scope>',
      'configuration scope',
      (value) => choice(value, scopes, 'scope'),
      'user',
    )
    .action(async (agent: string, options: { scope: Scope }, command: Command) => {
      const adapter = selectedAdapter(command, registry, agent);
      const results = await adapter[operation](options.scope);
      if (printResults(results, runtime)) runtime.setExitCode(1);
    });
}

export function createProgram(
  registry: AdapterRegistry,
  runtimeOverrides: Partial<CliRuntime> = {},
): Command {
  const runtime = resolveRuntime(runtimeOverrides);
  const program = new Command();
  program
    .name('agent-usage')
    .description('Track and report coding-agent skill and MCP usage')
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: runtime.writeOutput,
      writeErr: runtime.writeError,
    });

  program
    .command('report')
    .argument(
      '[range]',
      'named range',
      (value) => choice(value, namedRanges, 'range'),
      '7d',
    )
    .option('--agent <agent>', 'filter by agent')
    .option(
      '--kind <kind>',
      'filter by event kind',
      (value) => choice(value, eventKinds, 'kind'),
    )
    .action(
      (
        range: NamedRange,
        options: { agent?: string; kind?: UsageEvent['kind'] },
      ) => {
        const database = runtime.openDatabase(runtime.paths().database);
        try {
          const repository = runtime.createRepository(database);
          const since = namedRangeStart(range);
          const filter: QueryFilter = {
            ...(since === undefined ? {} : { since }),
            ...(options.agent === undefined ? {} : { agent: options.agent }),
            ...(options.kind === undefined ? {} : { kind: options.kind }),
          };
          runtime.writeOutput(
            renderUsageReportText(repository.report(filter, range)),
          );
        } finally {
          database.close();
        }
      },
    );

  program
    .command('mcp')
    .requiredOption('--agent <agent>', 'agent id')
    .action(async (options: { agent: string }) => {
      const database = runtime.openDatabase(runtime.paths().database);
      try {
        const repository = runtime.createRepository(database);
        const service = new UsageMcpService(
          repository,
          options.agent,
          runtime.randomId(),
          runtime.logger,
        );
        await runtime.runMcpServer(service);
      } finally {
        database.close();
      }
    });

  program
    .command('proxy')
    .requiredOption('--agent <agent>', 'agent id')
    .requiredOption('--server <server>', 'MCP server name')
    .argument('<command...>', 'server command and arguments')
    .allowUnknownOption()
    .passThroughOptions()
    .action(
      async (
        commandAndArguments: string[],
        options: { agent: string; server: string },
      ) => {
        const [command, ...args] = commandAndArguments;
        if (command === undefined) {
          program.error('missing server command');
          return;
        }
        const telemetry = initializeProxyTelemetry(
          runtime,
          options.agent,
          options.server,
        );
        try {
          const child = await runtime.runProxy(
            command,
            args,
            telemetry.observer,
            {
              cwd: runtime.cwd(),
              env: runtime.env,
            },
          );
          if (child.signal !== null) runtime.signalSelf(child.signal);
          else if (child.code !== null && child.code !== 0) {
            runtime.setExitCode(child.code);
          } else if (child.code === null) {
            runtime.setExitCode(1);
          }
        } finally {
          closeProxyTelemetry(runtime, telemetry.database);
        }
      },
    );

  program
    .command('list-targets <agent>')
    .action(
      async (
        agent: string,
        _options: object,
        command: Command,
      ) => {
        const adapter = selectedAdapter(command, registry, agent);
        printTargets(await adapter.listTargets(), runtime);
      },
    );

  program
    .command('configure <agent>')
    .option(
      '--native-skill <pattern>',
      'select a Skill for native hook collection',
      collectOption,
      [],
    )
    .option(
      '--inject-skill <pattern>',
      'select a Skill for MCP injection',
      collectOption,
      [],
    )
    .option(
      '--mcp <pattern>',
      'select an MCP server or qualified tool',
      collectOption,
      [],
    )
    .option(
      '--all-skills <mode>',
      'select every Skill in one collection mode',
      (value) => choice(value, skillModes, 'Skill mode'),
    )
    .option('--all-mcp', 'select every MCP server')
    .action(
      async (
        agent: string,
        options: ConfigureOptions,
        command: Command,
      ) => {
        const adapter = selectedAdapter(command, registry, agent);
        const policy = desiredSelectionPolicy(command, adapter, options);
        const targets = await adapter.listTargets();
        for (const skill of targets.skills) {
          let mode: SkillMode | undefined;
          try {
            mode = selectedSkillMode(policy, skill.name);
          } catch (error) {
            command.error(
              error instanceof Error ? error.message : String(error),
            );
          }
          if (
            mode !== undefined &&
            !skill.supportedModes.includes(mode)
          ) {
            command.error(
              `Skill "${skill.name}" does not support ${mode}.`,
            );
          }
        }
        if (!adapter.capabilities.nativeMcpEvents) {
          for (const server of targets.mcp) {
            if (
              server.transport !== 'stdio' &&
              selectsMcpServer(policy, server.server)
            ) {
              command.error(
                `MCP server "${server.server}" uses ${server.transport}, which requires native MCP events.`,
              );
            }
          }
        }

        printSelectionPolicy(policy, runtime);
        const results = await adapter.configure(policy);
        if (printResults(results, runtime)) runtime.setExitCode(1);
      },
    );

  for (const operation of ['install', 'sync', 'repair'] as const) {
    addLifecycleCommand(program, registry, runtime, operation);
  }

  program
    .command('uninstall <agent>')
    .option(
      '--scope <scope>',
      'configuration scope',
      (value) => choice(value, scopes, 'scope'),
      'user',
    )
    .option('--purge-data', 'delete shared usage data after uninstalling')
    .option('-y, --yes', 'confirm shared data deletion')
    .action(
      async (
        agent: string,
        options: { scope: Scope; purgeData?: boolean; yes?: boolean },
        command: Command,
      ) => {
        const adapter = selectedAdapter(command, registry, agent);
        const results = await adapter.uninstall(options.scope);
        if (printResults(results, runtime)) {
          runtime.setExitCode(1);
          return;
        }
        await maybePurgeData(registry, runtime, options);
      },
    );

  program
    .command('health [agent]')
    .action(
      async (
        agent: string | undefined,
        _options: object,
        command: Command,
      ) => {
        const adapters = agent === undefined
          ? registry.list()
          : [selectedAdapter(command, registry, agent)];
        if (adapters.length === 0) {
          runtime.writeOutput('No adapters registered.\n');
          return;
        }

        for (const adapter of adapters) {
          const coverage = await adapter.health();
          runtime.writeOutput(`${coverage.agent}\n`);
          printCapabilities(adapter.capabilities, runtime);
          runtime.writeOutput(`  Skills: ${coverage.skills}\n`);
          runtime.writeOutput(`  MCP: ${coverage.mcp}\n`);
          if (coverage.issues.length === 0) {
            runtime.writeOutput('  Issues: none\n');
          } else {
            runtime.writeOutput('  Issues:\n');
            for (const issue of coverage.issues) {
              runtime.writeOutput(`  - ${issue}\n`);
            }
          }
        }
      },
    );

  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  registry: AdapterRegistry = new AdapterRegistry(),
  runtimeOverrides: Partial<CliRuntime> = {},
): Promise<void> {
  const runtime = resolveRuntime(runtimeOverrides);
  try {
    await createProgram(registry, runtime).parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) runtime.setExitCode(error.exitCode);
      return;
    }
    runtime.writeError(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    runtime.setExitCode(1);
  }
}

const isEntrypoint = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntrypoint) {
  await runCli();
}
