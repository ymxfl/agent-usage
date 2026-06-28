import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { realpathSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  checkbox,
  confirm as inquirerConfirm,
  input,
  select,
} from '@inquirer/prompts';
import {
  Command,
  CommanderError,
  InvalidArgumentError,
} from 'commander';

import { AdapterRegistry } from './adapters/registry.js';
import type {
  AgentAdapter,
  Capabilities,
  CoverageReport,
  DiscoveredTargets,
  OperationResult,
  Scope,
} from './adapters/types.js';
import { defaultClaudeAdapter } from './adapters/claude/adapter.js';
import { defaultJoyCodeAdapter } from './adapters/joycode/adapter.js';
import {
  consumeClaudeHook,
  type ClaudeNormalizerDependencies,
} from './adapters/claude/hook-command.js';
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
  emptyAgentSelection,
  loadSelectionConfig,
  matchSelectionPattern,
  saveSelectionConfig,
  selectedMcp,
  selectedSkillMode,
  skillModes,
  type AgentSelectionPolicy,
  type SelectionConfig,
  type SkillMode,
  emptySelectionConfig,
} from './core/selection.js';
import { createWebhookReporter } from './core/webhook.js';
import { runUsageMcpServer, type McpLifecycle } from './mcp/server.js';
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
import {
  renderUsageReportText,
  type Language,
} from './report/text.js';
import { startAgentUsageWebServer } from './web/server.js';

export interface CliDatabase {
  close(): void;
}

export interface CliRepository extends UsageMcpRepository {
  report(filter: QueryFilter, rangeLabel: string): UsageReport;
}

export interface CliRuntime {
  paths(): UsagePaths;
  loadSelectionConfig(path: string): Promise<SelectionConfig>;
  saveSelectionConfig(path: string, config: SelectionConfig): Promise<void>;
  openDatabase(path: string): CliDatabase;
  createRepository(
    database: CliDatabase,
    config?: SelectionConfig,
  ): CliRepository;
  runMcpServer(service: UsageMcpService, lifecycle?: McpLifecycle): Promise<void>;
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
  language(): Language;
  prompt(message: string): Promise<string>;
  select<T extends string>(
    message: string,
    choices: Array<ChoiceItem<T>>,
    defaultValue?: T,
  ): Promise<T>;
  multiSelect<T extends string>(
    message: string,
    choices: Array<ChoiceItem<T>>,
    defaults?: readonly T[],
    manualLabel?: string,
  ): Promise<T[]>;
  confirm(message: string): Promise<boolean>;
  purgeData(paths: UsagePaths): void;
  logger: McpProtocolLogger;
  readStdin(): Promise<string>;
  appendError(path: string, message: string): Promise<void>;
}

const namedRanges = ['today', '7d', '30d', 'all'] as const;
const eventKinds = [
  'skill_session_load',
  'skill_invocation',
  'mcp_call',
] as const;
const scopes = ['user', 'project'] as const;
const languages = ['zh', 'en'] as const;

function languageFrom(value: string | undefined): Language {
  return value === 'en' ? 'en' : 'zh';
}

function isLanguage(value: string): value is Language {
  return (languages as readonly string[]).includes(value);
}

function languageChoice(value: string): Language {
  if (isLanguage(value)) return value;
  throw new InvalidArgumentError(
    `invalid language "${value}". Allowed choices are zh, en.`,
  );
}

function commandLanguage(command: Command, runtime: CliRuntime): Language {
  const options = command.optsWithGlobals() as { lang?: Language };
  return options.lang ?? runtime.language();
}

function defaultRuntime(): CliRuntime {
  return {
    paths: usagePaths,
    loadSelectionConfig,
    saveSelectionConfig,
    openDatabase: openUsageDatabase,
    createRepository: (database, config) => {
      const onInsert = createWebhookReporter(config?.webhook, console);
      return new UsageRepository(
        database as DatabaseSync,
        onInsert === undefined ? {} : { onInsert },
      );
    },
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
    language: () => languageFrom(process.env.AGENT_USAGE_LANG),
    prompt: async (message) => input({ message }),
    select: async (message, choices, defaultValue) =>
      select({
        message,
        default: defaultValue,
        choices: choices.map((choice) => ({
          name: choice.label,
          value: choice.value,
        })),
      }),
    multiSelect: async (message, choices, defaults = [], manualLabel) => {
      const manualValue = '__manual_input__';
      const selected = await checkbox<string>({
        message,
        choices: [
          ...choices.map((choice, index) => ({
            name: `${index + 1}. ${choice.label}`,
            value: choice.value,
            checked:
              defaults.includes(choice.value) || choice.selected === true,
          })),
          ...(manualLabel === undefined
            ? []
            : [{ name: manualLabel, value: manualValue }]),
        ],
      });
      if (!selected.includes(manualValue)) {
        return choices
          .map((choice) => choice.value)
          .filter((value) => selected.includes(value));
      }
      const answer = await input({
        message: manualLabel ?? 'Enter numbers separated by comma or space',
        validate: (value) =>
          parseMultiSelectAnswer(value, choices) === undefined
            ? 'Enter numbers, values, all, or none.'
            : true,
      });
      return parseMultiSelectAnswer(answer, choices) ?? [];
    },
    confirm: async (message) => inquirerConfirm({ message, default: false }),
    purgeData: (paths) => rmSync(paths.root, { recursive: true, force: true }),
    logger: console,
    readStdin: async () => {
      let buffer = '';
      for await (const chunk of process.stdin) {
        buffer += chunk.toString();
      }
      return buffer;
    },
    appendError: async (path, message) => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${new Date().toISOString()} ${message}\n`);
    },
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

function portChoice(value: string): number {
  const port = Number(value);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
  throw new InvalidArgumentError(
    `invalid port "${value}". Expected an integer between 0 and 65535.`,
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
  language: Language = runtime.language(),
): void {
  const t = cliText[language];
  for (const [name, supported] of Object.entries(capabilities)) {
    runtime.writeOutput(`  ${name}: ${supported ? t.yes : t.no}\n`);
  }
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function targetSortKey(scope: Scope, name: string, detail: string): string {
  return `${scope === 'user' ? '0' : '1'}\0${name}\0${detail}`;
}

const cliText = {
  en: {
    colon: ':',
    valueSeparator: ' ',
    none: 'none',
    yes: 'yes',
    no: 'no',
    selected: 'selected',
    noTargets: 'No targets discovered.',
    skills: 'Skills',
    unresolved: 'Unresolved patterns',
    issues: 'Issues',
    desiredPolicy: 'Desired policy',
    languagePrompt: 'Select language / 选择语言',
    selectOperation: 'Select operation',
    selectAgent: 'Select agent',
    selectScope: 'Select scope',
    selectReportRange: 'Select report range',
    selectNativeSkills: 'Select Skills for native_hook',
    selectInjectedSkills: 'Select Skills for injected_mcp',
    selectMcpServers: 'Select MCP servers',
    manualInput: 'Enter numbers separated by comma or space',
    noneAvailable: 'none available',
    applyConfiguration: 'Apply this configuration?',
    configurationCancelled: 'Configuration cancelled.',
    requiresTty:
      'Interactive mode requires a TTY. Use a subcommand for non-interactive use.',
    noAdapters: 'No adapters are registered.',
    noAdaptersRegistered: 'No adapters registered',
    webhookEnabled: 'Webhook enabled',
    webhookDisabled: 'Webhook disabled',
    webhookNotConfigured: 'Webhook: none',
    webhookCurrent: 'Webhook',
    webListening: 'Web console listening',
    operationLabels: {
      install: 'Install adapter files',
      configure: 'Configure Skill and MCP targets',
      sync: 'Sync newly discovered targets',
      repair: 'Repair managed files',
      uninstall: 'Uninstall adapter files',
      'list-targets': 'List selectable targets',
      health: 'Show health',
      report: 'Show usage report',
    },
  },
  zh: {
    colon: '：',
    valueSeparator: '',
    none: '无',
    yes: '是',
    no: '否',
    selected: '已选',
    noTargets: '未发现可配置目标。',
    skills: 'Skills',
    unresolved: '未匹配的选择模式',
    issues: '问题',
    desiredPolicy: '目标配置',
    languagePrompt: '选择语言 / Select language',
    selectOperation: '选择操作',
    selectAgent: '选择 agent',
    selectScope: '选择配置范围',
    selectReportRange: '选择报告范围',
    selectNativeSkills: '选择 native_hook Skills',
    selectInjectedSkills: '选择 injected_mcp Skills',
    selectMcpServers: '选择 MCP 服务',
    manualInput: '输入编号，使用逗号或空格分隔',
    noneAvailable: '无可选项',
    applyConfiguration: '应用这个配置？',
    configurationCancelled: '已取消配置。',
    requiresTty: '交互模式需要 TTY。非交互使用请指定子命令。',
    noAdapters: '没有已注册的 adapter。',
    noAdaptersRegistered: '没有已注册的 adapter',
    webhookEnabled: 'Webhook 已启用',
    webhookDisabled: 'Webhook 已停用',
    webhookNotConfigured: 'Webhook：无',
    webhookCurrent: 'Webhook',
    webListening: 'Web 控制台已启动',
    operationLabels: {
      install: '安装 adapter 文件',
      configure: '配置 Skill 和 MCP 目标',
      sync: '同步新发现的目标',
      repair: '修复托管文件',
      uninstall: '卸载 adapter 文件',
      'list-targets': '列出可选择目标',
      health: '查看健康状态',
      report: '查看使用报告',
    },
  },
} as const;

function printTargets(
  targets: DiscoveredTargets,
  runtime: CliRuntime,
  language: Language = runtime.language(),
): void {
  const t = cliText[language];
  runtime.writeOutput(`${targets.agent}\n`);
  if (targets.skills.length === 0 && targets.mcp.length === 0) {
    runtime.writeOutput(`  ${t.noTargets}\n`);
  }

  if (targets.skills.length === 0) {
    runtime.writeOutput(`  ${t.skills}${t.colon}${t.valueSeparator}${t.none}\n`);
  } else {
    runtime.writeOutput(`  ${t.skills}${t.colon}\n`);
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
      const selected = skill.selectedMode ?? t.none;
      runtime.writeOutput(
        `  - ${skill.name} [${skill.scope}] ${modes} (${t.selected}: ${selected}) ${skill.path}\n`,
      );
    }
  }

  if (targets.mcp.length === 0) {
    runtime.writeOutput(`  MCP${t.colon}${t.valueSeparator}${t.none}\n`);
  } else {
    runtime.writeOutput(`  MCP${t.colon}\n`);
    const servers = [...targets.mcp].sort((left, right) =>
      compareText(
        targetSortKey(left.scope, left.server, left.transport),
        targetSortKey(right.scope, right.server, right.transport),
      )
    );
    for (const server of servers) {
      runtime.writeOutput(
        `  - ${server.server} [${server.scope}] ${server.transport} (${t.selected}: ${server.selected === true ? t.yes : t.no})\n`,
      );
    }
  }

  if (targets.unresolved.length === 0) {
    runtime.writeOutput(`  ${t.unresolved}${t.colon}${t.valueSeparator}${t.none}\n`);
  } else {
    runtime.writeOutput(`  ${t.unresolved}${t.colon}\n`);
    for (const pattern of [...targets.unresolved].sort(compareText)) {
      runtime.writeOutput(`  - ${pattern}\n`);
    }
  }

  if (targets.issues.length === 0) {
    runtime.writeOutput(`  ${t.issues}${t.colon}${t.valueSeparator}${t.none}\n`);
  } else {
    runtime.writeOutput(`  ${t.issues}${t.colon}\n`);
    for (const issue of [...targets.issues].sort(compareText)) {
      runtime.writeOutput(`  - ${issue}\n`);
    }
  }
}

function printSelectionPolicy(
  policy: AgentSelectionPolicy,
  runtime: CliRuntime,
  language: Language = runtime.language(),
): void {
  const t = cliText[language];
  const display = (patterns: string[]): string =>
    patterns.length === 0 ? t.none : patterns.join(', ');
  runtime.writeOutput(`${t.desiredPolicy}${t.colon}\n`);
  runtime.writeOutput(
    `  Skills (native_hook): ${display(policy.skills.native_hook)}\n`,
  );
  runtime.writeOutput(
    `  Skills (injected_mcp): ${display(policy.skills.injected_mcp)}\n`,
  );
  runtime.writeOutput(`  MCP: ${display(policy.mcp)}\n`);
}

function printHealth(
  capabilities: Capabilities,
  coverage: CoverageReport,
  runtime: CliRuntime,
  language: Language = runtime.language(),
): void {
  const t = cliText[language];
  runtime.writeOutput(`${coverage.agent}\n`);
  printCapabilities(capabilities, runtime, language);
  runtime.writeOutput(`  Skills${t.colon} ${coverage.skills}\n`);
  runtime.writeOutput(`  MCP${t.colon} ${coverage.mcp}\n`);
  if (coverage.issues.length === 0) {
    runtime.writeOutput(`  ${t.issues}${t.colon} ${t.none}\n`);
  } else {
    runtime.writeOutput(`  ${t.issues}${t.colon}\n`);
    for (const issue of coverage.issues) {
      runtime.writeOutput(`  - ${issue}\n`);
    }
  }
}

function collectOption(value: string, previous: string[]): string[] {
  if (value.length === 0) {
    throw new InvalidArgumentError('selection pattern must not be empty');
  }
  return previous.includes(value) ? previous : [...previous, value];
}

interface ConfigureOptions {
  nativeSkill: string[];
  injectSkill: string[];
  mcp: string[];
  allSkills?: SkillMode;
  allMcp?: boolean;
}

type WizardOperation =
  | 'install'
  | 'configure'
  | 'sync'
  | 'repair'
  | 'uninstall'
  | 'list-targets'
  | 'health'
  | 'report';

interface ChoiceItem<T extends string> {
  value: T;
  label: string;
  selected?: boolean;
}

const wizardOperationValues: readonly WizardOperation[] = [
  'install',
  'configure',
  'sync',
  'repair',
  'uninstall',
  'list-targets',
  'health',
  'report',
];

function wizardOperations(language: Language): Array<ChoiceItem<WizardOperation>> {
  const labels = cliText[language].operationLabels;
  return wizardOperationValues.map((value) => ({
    value,
    label: labels[value],
  }));
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

function selectionPolicyError(
  adapter: AgentAdapter,
  targets: DiscoveredTargets,
  policy: AgentSelectionPolicy,
): string | undefined {
  for (const skill of targets.skills) {
    let mode: SkillMode | undefined;
    try {
      mode = selectedSkillMode(policy, skill.name);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (mode !== undefined && !skill.supportedModes.includes(mode)) {
      return `Skill "${skill.name}" does not support ${mode}.`;
    }
  }

  if (!adapter.capabilities.nativeMcpEvents) {
    for (const server of targets.mcp) {
      if (
        server.transport !== 'stdio' &&
        selectsMcpServer(policy, server.server)
      ) {
        return `MCP server "${server.server}" uses ${server.transport}, which requires native MCP events.`;
      }
    }
  }

  return undefined;
}

function normalizePromptAnswer(answer: string): string {
  return answer.trim().toLowerCase();
}

function parseMultiSelectAnswer<T extends string>(
  answer: string,
  choices: Array<ChoiceItem<T>>,
): T[] | undefined {
  const normalized = normalizePromptAnswer(answer);
  if (normalized === '') return [];
  if (normalized === 'all') return choices.map((choice) => choice.value);
  if (normalized === 'none') return [];

  const selected = new Set<T>();
  const tokens = normalized.split(/[,\s]+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    const number = Number(token);
    const selectedChoice = Number.isInteger(number)
      ? choices[number - 1]
      : choices.find(
          (choice) =>
            choice.value.toLowerCase() === token ||
            choice.label.toLowerCase() === token,
        );
    if (selectedChoice === undefined) return undefined;
    selected.add(selectedChoice.value);
  }

  return choices
    .map((choice) => choice.value)
    .filter((value) => selected.has(value));
}

async function promptChoice<T extends string>(
  runtime: CliRuntime,
  message: string,
  choices: Array<ChoiceItem<T>>,
  defaultValue?: T,
): Promise<T> {
  return runtime.select(message, choices, defaultValue);
}

async function promptMultiSelect<T extends string>(
  runtime: CliRuntime,
  message: string,
  choices: Array<ChoiceItem<T>>,
  defaults: readonly T[] = [],
  language: Language = runtime.language(),
): Promise<T[]> {
  if (choices.length === 0) {
    runtime.writeError(`${message}${cliText[language].colon} ${cliText[language].noneAvailable}\n`);
    return [];
  }

  return runtime.multiSelect(
    message,
    choices,
    defaults,
    cliText[language].manualInput,
  );
}

function epsilonClosure(
  pattern: string,
  initial: Iterable<number>,
): Set<number> {
  const states = new Set(initial);
  const pending = [...states];
  while (pending.length > 0) {
    const state = pending.pop();
    if (state === undefined || pattern[state] !== '*') continue;
    const next = state + 1;
    if (!states.has(next)) {
      states.add(next);
      pending.push(next);
    }
  }
  return states;
}

function statesAfterFixedPrefix(
  pattern: string,
  prefix: string,
): Set<number> {
  let states = epsilonClosure(pattern, [0]);
  for (let index = 0; index < prefix.length; index += 1) {
    const character = prefix[index];
    const next = new Set<number>();
    for (const state of states) {
      const token = pattern[state];
      if (token === '*') next.add(state);
      else if (token === character) next.add(state + 1);
    }
    states = epsilonClosure(pattern, next);
    if (states.size === 0) return states;
  }
  return states;
}

function canMatchNonemptySuffix(
  pattern: string,
  initial: Iterable<number>,
): boolean {
  const queue: Array<{ state: number; consumed: boolean }> = [];
  const visited = new Set<string>();
  const enqueue = (state: number, consumed: boolean): void => {
    const key = `${state}:${consumed ? 1 : 0}`;
    if (visited.has(key)) return;
    visited.add(key);
    queue.push({ state, consumed });
  };
  for (const state of initial) enqueue(state, false);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) continue;
    if (current.state === pattern.length) {
      if (current.consumed) return true;
      continue;
    }

    if (pattern[current.state] === '*') {
      enqueue(current.state + 1, current.consumed);
      enqueue(current.state, true);
    } else {
      enqueue(current.state + 1, true);
    }
  }
  return false;
}

function globCanSelectQualifiedTool(
  pattern: string,
  server: string,
): boolean {
  const states = statesAfterFixedPrefix(pattern, `${server}.`);
  return canMatchNonemptySuffix(pattern, states);
}

function selectsMcpServer(
  policy: AgentSelectionPolicy,
  server: string,
): boolean {
  return policy.mcp.some(
    (pattern) =>
      matchSelectionPattern(pattern, server) ||
      globCanSelectQualifiedTool(pattern, server),
  );
}

function agentChoices(registry: AdapterRegistry): Array<ChoiceItem<string>> {
  return registry.list()
    .map((adapter) => ({ value: adapter.id, label: adapter.id }))
    .sort((left, right) => compareText(left.value, right.value));
}

function scopeChoices(): Array<ChoiceItem<Scope>> {
  return scopes.map((scope) => ({ value: scope, label: scope }));
}

function skillChoices(
  targets: DiscoveredTargets,
  mode: SkillMode,
): Array<ChoiceItem<string>> {
  return targets.skills
    .filter((skill) => skill.supportedModes.includes(mode))
    .sort((left, right) =>
      compareText(
        targetSortKey(left.scope, left.name, left.path),
        targetSortKey(right.scope, right.name, right.path),
      )
    )
    .map((skill) => ({
      value: skill.name,
      label: `${skill.name} [${skill.scope}] ${skill.path}`,
      selected: skill.selectedMode === mode,
    }));
}

function mcpChoices(
  adapter: AgentAdapter,
  targets: DiscoveredTargets,
): Array<ChoiceItem<string>> {
  if (!adapter.capabilities.nativeMcpEvents && !adapter.capabilities.stdioMcpProxy) {
    return [];
  }
  return targets.mcp
    .filter((server) =>
      adapter.capabilities.nativeMcpEvents || server.transport === 'stdio'
    )
    .sort((left, right) =>
      compareText(
        targetSortKey(left.scope, left.server, left.transport),
        targetSortKey(right.scope, right.server, right.transport),
      )
    )
    .map((server) => ({
      value: server.server,
      label: `${server.server} [${server.scope}] ${server.transport}`,
      selected: server.selected === true,
    }));
}

async function runInteractiveConfigure(
  adapter: AgentAdapter,
  runtime: CliRuntime,
  language: Language,
): Promise<void> {
  const t = cliText[language];
  const targets = await adapter.listTargets();
  printTargets(targets, runtime, language);

  const nativeChoices = adapter.capabilities.nativeSkillEvents
    ? skillChoices(targets, 'native_hook')
    : [];
  const injectedChoices = adapter.capabilities.skillInjection
    ? skillChoices(targets, 'injected_mcp')
    : [];
  const serverChoices = mcpChoices(adapter, targets);

  const nativeHook = await promptMultiSelect(
    runtime,
    t.selectNativeSkills,
    nativeChoices,
    nativeChoices
      .filter((choice) => choice.selected === true)
      .map((choice) => choice.value),
    language,
  );
  const injectedMcp = await promptMultiSelect(
    runtime,
    t.selectInjectedSkills,
    injectedChoices,
    injectedChoices
      .filter((choice) => choice.selected === true)
      .map((choice) => choice.value),
    language,
  );
  const mcp = await promptMultiSelect(
    runtime,
    t.selectMcpServers,
    serverChoices,
    serverChoices
      .filter((choice) => choice.selected === true)
      .map((choice) => choice.value),
    language,
  );

  const policy: AgentSelectionPolicy = {
    skills: { native_hook: nativeHook, injected_mcp: injectedMcp },
    mcp,
  };
  const error = selectionPolicyError(adapter, targets, policy);
  if (error !== undefined) {
    runtime.writeError(`${error}\n`);
    runtime.setExitCode(1);
    return;
  }

  printSelectionPolicy(policy, runtime, language);
  if (!(await runtime.confirm(t.applyConfiguration))) {
    runtime.writeError(`${t.configurationCancelled}\n`);
    runtime.setExitCode(1);
    return;
  }

  const results = await adapter.configure(policy);
  if (printResults(results, runtime)) runtime.setExitCode(1);
}

async function runInteractiveReport(
  runtime: CliRuntime,
  agent: string,
  language: Language,
): Promise<void> {
  const t = cliText[language];
  const range = await promptChoice(
    runtime,
    t.selectReportRange,
    namedRanges.map((range) => ({ value: range, label: range })),
    '7d',
  );
  const database = runtime.openDatabase(runtime.paths().database);
  try {
    const repository = runtime.createRepository(database);
    const since = namedRangeStart(range);
    runtime.writeOutput(
      renderUsageReportText(
        repository.report(
          { ...(since === undefined ? {} : { since }), agent },
          range,
        ),
        language,
      ),
    );
  } finally {
    database.close();
  }
}

async function runInteractiveWizard(
  registry: AdapterRegistry,
  runtime: CliRuntime,
  initialLanguage: Language,
): Promise<void> {
  if (!runtime.isTTY()) {
    runtime.writeError(`${cliText[initialLanguage].requiresTty}\n`);
    runtime.setExitCode(1);
    return;
  }

  const language = await promptChoice(
    runtime,
    cliText[initialLanguage].languagePrompt,
    [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' },
    ],
    initialLanguage,
  );
  const t = cliText[language];

  const agents = agentChoices(registry);
  if (agents.length === 0) {
    runtime.writeError(`${t.noAdapters}\n`);
    runtime.setExitCode(1);
    return;
  }

  const operation = await promptChoice(
    runtime,
    t.selectOperation,
    wizardOperations(language),
  );
  const agent = await promptChoice(runtime, t.selectAgent, agents);
  const adapter = registry.get(agent);

  if (operation === 'configure') {
    await runInteractiveConfigure(adapter, runtime, language);
    return;
  }
  if (operation === 'list-targets') {
    printTargets(await adapter.listTargets(), runtime, language);
    return;
  }
  if (operation === 'health') {
    const coverage = await adapter.health();
    printHealth(adapter.capabilities, coverage, runtime, language);
    return;
  }
  if (operation === 'report') {
    await runInteractiveReport(runtime, agent, language);
    return;
  }

  const scope = await promptChoice(runtime, t.selectScope, scopeChoices(), 'user');
  const results = await adapter[operation](scope);
  if (printResults(results, runtime)) runtime.setExitCode(1);
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

const noopProtocolObserver: StdioProtocolObserver = {
  observeClientChunk: () => {},
  observeServerChunk: () => {},
  endClientStream: () => {},
  endServerStream: () => {},
  close: () => {},
};

async function initializeProxyTelemetry(
  runtime: CliRuntime,
  agent: string,
  server: string,
): Promise<{
  database: CliDatabase | undefined;
  observer: StdioProtocolObserver;
}> {
  let database: CliDatabase | undefined;

  try {
    const paths = runtime.paths();
    const config = await runtime.loadSelectionConfig(paths.config);
    const policy = config.agents[agent] ?? emptyAgentSelection();
    if (policy.mcp.length === 0) {
      return { database: undefined, observer: noopProtocolObserver };
    }

    database = runtime.openDatabase(paths.database);
    const repository = runtime.createRepository(database, config);
    const emit = (event: UsageEvent): unknown => {
      if (
        event.kind !== 'mcp_call' ||
        event.mcpServer === undefined ||
        !selectedMcp(policy, event.mcpServer, event.name)
      ) {
        return false;
      }
      return repository.insert(event);
    };
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
  } catch (error) {
    logTelemetryError(runtime, 'Failed to initialize proxy telemetry', error);
  }

  return { database, observer: noopProtocolObserver };
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
    .option('--lang <lang>', 'output language: zh or en', languageChoice)
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: runtime.writeOutput,
      writeErr: runtime.writeError,
    });

  program.action(async () => {
    await runInteractiveWizard(registry, runtime, commandLanguage(program, runtime));
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
        command: Command,
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
            renderUsageReportText(
              repository.report(filter, range),
              commandLanguage(command, runtime),
            ),
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
      const paths = runtime.paths();
      const config = await runtime.loadSelectionConfig(paths.config);
      const database = runtime.openDatabase(paths.database);
      try {
        const repository = runtime.createRepository(database, config);
        const service = new UsageMcpService(
          repository,
          options.agent,
          runtime.randomId(),
          runtime.logger,
        );
        // If the adapter for this agent exposes an MCP lifecycle (e.g. JoyCode's
        // skill watcher), wire it into the session so the advertised capability
        // is delivered. Adapters without one (Claude, unknown) get none.
        let lifecycle: McpLifecycle | undefined;
        const adapter = registry.tryGet(options.agent);
        if (adapter !== undefined) {
          lifecycle = await adapter.createMcpLifecycle?.();
        }
        await runtime.runMcpServer(service, lifecycle);
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
        const telemetry = await initializeProxyTelemetry(
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
        printTargets(
          await adapter.listTargets(),
          runtime,
          commandLanguage(command, runtime),
        );
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
        const error = selectionPolicyError(adapter, targets, policy);
        if (error !== undefined) {
          command.error(error);
        }

        printSelectionPolicy(policy, runtime, commandLanguage(command, runtime));
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
        const language = commandLanguage(command, runtime);
        const adapters = agent === undefined
          ? registry.list()
          : [selectedAdapter(command, registry, agent)];
        if (adapters.length === 0) {
          runtime.writeOutput(`${cliText[language].noAdaptersRegistered}\n`);
          return;
        }

        for (const adapter of adapters) {
          const coverage = await adapter.health();
          printHealth(adapter.capabilities, coverage, runtime, language);
        }
      },
    );

  const webhook = program.command('webhook');

  webhook
    .command('set <url>')
    .action(async (url: string, _options: object, command: Command) => {
      const language = commandLanguage(command, runtime);
      const paths = runtime.paths();
      const config = await runtime.loadSelectionConfig(paths.config);
      await runtime.saveSelectionConfig(paths.config, {
        ...config,
        webhook: { enabled: true, url },
      });
      runtime.writeOutput(`${cliText[language].webhookEnabled}${cliText[language].colon} ${url}\n`);
    });

  webhook
    .command('unset')
    .action(async (_options: object, command: Command) => {
      const language = commandLanguage(command, runtime);
      const paths = runtime.paths();
      const config = await runtime.loadSelectionConfig(paths.config);
      const { webhook: _webhook, ...nextConfig } = config;
      await runtime.saveSelectionConfig(paths.config, nextConfig);
      runtime.writeOutput(`${cliText[language].webhookDisabled}\n`);
    });

  webhook
    .command('show')
    .action(async (_options: object, command: Command) => {
      const language = commandLanguage(command, runtime);
      const config = await runtime
        .loadSelectionConfig(runtime.paths().config)
        .catch(() => emptySelectionConfig());
      if (config.webhook === undefined) {
        runtime.writeOutput(`${cliText[language].webhookNotConfigured}\n`);
        return;
      }
      runtime.writeOutput(
        `${cliText[language].webhookCurrent}${cliText[language].colon} ${config.webhook.enabled ? 'enabled' : 'disabled'} ${config.webhook.url}\n`,
      );
    });

  program
    .command('web')
    .option('--host <host>', 'listen host', '127.0.0.1')
    .option('--port <port>', 'listen port', portChoice, 17891)
    .action(
      async (
        options: { host: string; port: number },
        command: Command,
      ) => {
        const language = commandLanguage(command, runtime);
        const server = await startAgentUsageWebServer({
          registry,
          runtime,
          host: options.host,
          port: options.port,
        });
        runtime.writeOutput(`${cliText[language].webListening}${cliText[language].colon} ${server.url}\n`);
        await new Promise<void>((resolve) => {
          const close = (): void => {
            process.off('SIGINT', close);
            process.off('SIGTERM', close);
            void server.close().finally(resolve);
          };
          process.once('SIGINT', close);
          process.once('SIGTERM', close);
        });
      },
    );

  program
    .command('hook claude', { hidden: true })
    .action(async () => {
      await runClaudeHookCommand(runtime);
    });

  return program;
}

async function runClaudeHookCommand(runtime: CliRuntime): Promise<void> {
  const paths = runtime.paths();
  const text = await runtime.readStdin();

  let database: CliDatabase | undefined;
  let repository: CliRepository | undefined;
  let selectionConfig: SelectionConfig | undefined;
  const normalizerDependencies: ClaudeNormalizerDependencies = {
    now: () => new Date(),
    randomUUID,
  };

  const logError = (message: string, error: unknown): Promise<void> =>
    runtime.appendError(paths.errors, errorMessage(message, error));

  try {
    await consumeClaudeHook(text, {
      loadSelectionConfig: async () => {
        selectionConfig = await runtime.loadSelectionConfig(paths.config);
        return selectionConfig;
      },
      insert: (event) => {
        if (database === undefined) {
          database = runtime.openDatabase(paths.database);
          repository = runtime.createRepository(database, selectionConfig);
        }
        return repository!.insert(event);
      },
      logError,
      normalizerDependencies,
    });
  } finally {
    try {
      database?.close();
    } catch (error) {
      try {
        await runtime.appendError(
          paths.errors,
          errorMessage('Failed to close Claude hook database', error),
        );
      } catch {
        // Best-effort cleanup logging; never let it escape the hook.
      }
    }
  }
}

function errorMessage(message: string, error: unknown): string {
  return `${message}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Build the default adapter registry used when the caller does not supply one.
 * The real Claude Code adapter is registered against the current user HOME and
 * the built runtime bundle; if the runtime bundle is unavailable (e.g. running
 * from source before a build) the registry is returned empty so the rest of the
 * CLI still functions. Tests always pass an explicit registry, so they are
 * unaffected by this default wiring.
 */
async function defaultRegistry(): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  const claude = await defaultClaudeAdapter();
  if (claude !== undefined) registry.register(claude);
  const joycode = await defaultJoyCodeAdapter();
  if (joycode !== undefined) registry.register(joycode);
  return registry;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  registry?: AdapterRegistry,
  runtimeOverrides: Partial<CliRuntime> = {},
): Promise<void> {
  const runtime = resolveRuntime(runtimeOverrides);
  const resolved = registry ?? (await defaultRegistry());
  try {
    await createProgram(resolved, runtime).parseAsync([...argv]);
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

// Symlink-tolerant entrypoint detection: `fileURLToPath(import.meta.url)`
// resolves symlinks (Node loads the canonical file), while `process.argv[1]`
// is whatever the caller passed and may still contain symlinks (e.g. `/tmp` on
// macOS, which links to `/private/tmp`). Comparing them verbatim makes the
// runtime a silent no-op when invoked via a symlinked path — which is exactly
// how the JoyCode runtime is launched from `~/.joycode`. Normalize the argv
// path through realpath so the two sides agree.
function isMainEntrypoint(): boolean {
  const argvPath = process.argv[1];
  if (argvPath === undefined) return false;
  const invoked = fileURLToPath(import.meta.url);
  if (invoked === resolve(argvPath)) return true;
  try {
    return realpathSync(argvPath) === invoked;
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  await runCli();
}
