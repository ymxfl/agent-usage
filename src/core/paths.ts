import { homedir } from 'node:os';
import { join } from 'node:path';

export interface UsagePaths {
  root: string;
  database: string;
  state: string;
  errors: string;
}

export function usagePaths(
  root = process.env.AGENT_USAGE_HOME ?? join(homedir(), '.agent-usage'),
): UsagePaths {
  const state = join(root, 'state');

  return {
    root,
    database: join(root, 'usage.db'),
    state,
    errors: join(root, 'logs', 'errors.log'),
  };
}
