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

export interface AgentAdapter {
  readonly id: string;
  readonly capabilities: Capabilities;
  discover(): Promise<string[]>;
  install(scope: Scope): Promise<OperationResult[]>;
  sync(scope: Scope): Promise<OperationResult[]>;
  repair(scope: Scope): Promise<OperationResult[]>;
  uninstall(scope: Scope): Promise<OperationResult[]>;
  health(): Promise<CoverageReport>;
}
