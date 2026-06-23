import type {
  AgentSelectionPolicy,
  SkillMode,
} from '../core/selection.js';
import type { McpLifecycle } from '../mcp/server.js';

export type Scope = 'user' | 'project';

export type Status = 'success' | 'degraded' | 'skipped' | 'failed';

export interface Capabilities {
  nativeSkillEvents: boolean;
  skillInjection: boolean;
  nativeMcpEvents: boolean;
  stdioMcpProxy: boolean;
  skillWatching: boolean;
}

export interface OperationResult {
  status: Status;
  path?: string;
  message: string;
}

export interface CoverageReport {
  agent: string;
  skills: string;
  mcp: string;
  issues: string[];
}

export interface DiscoveredSkill {
  name: string;
  scope: Scope;
  path: string;
  supportedModes: SkillMode[];
  selectedMode?: SkillMode;
}

export interface DiscoveredMcp {
  server: string;
  scope: Scope;
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  selected?: boolean;
}

export interface DiscoveredTargets {
  agent: string;
  skills: DiscoveredSkill[];
  mcp: DiscoveredMcp[];
  unresolved: string[];
  issues: string[];
}

export interface AgentAdapter {
  readonly id: string;
  readonly capabilities: Capabilities;
  discover(): Promise<string[]>;
  listTargets(): Promise<DiscoveredTargets>;
  configure(policy: AgentSelectionPolicy): Promise<OperationResult[]>;
  install(scope: Scope): Promise<OperationResult[]>;
  sync(scope: Scope): Promise<OperationResult[]>;
  repair(scope: Scope): Promise<OperationResult[]>;
  uninstall(scope: Scope): Promise<OperationResult[]>;
  health(): Promise<CoverageReport>;
  /**
   * Optional lifecycle bound to a live MCP session. When implemented, the CLI
   * `mcp --agent <id>` command awaits it and wires `start()`/`close()` into the
   * stdio server so the adapter can begin/stop background work (e.g. a skill
   * watcher) for the duration of the session. Adapters that don't need it omit
   * the method (or return `undefined`), keeping the contract optional and
   * backward compatible.
   */
  createMcpLifecycle?(): Promise<McpLifecycle | undefined>;
}
