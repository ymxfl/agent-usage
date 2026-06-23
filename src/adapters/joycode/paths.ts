import { join } from 'node:path';

/**
 * Pure composition of JoyCode's configuration paths.
 *
 * JoyCode config lives under `~/.joycode/` (user scope) and
 * `<project>/.joycode/` (project scope). This helper performs NO environment
 * reads — `home` and `cwd` are supplied by the caller so the function is fully
 * deterministic and trivially testable.
 */
export interface JoyCodePaths {
  userMcp: string;
  projectMcp: string;
  userSkills: string;
  projectSkills: string;
  userPrompts: string;
  projectPrompts: string;
}

export function joyCodePaths(home: string, cwd: string): JoyCodePaths {
  return {
    userMcp: join(home, '.joycode', 'joycode-mcp.json'),
    projectMcp: join(cwd, '.joycode', 'mcp.json'),
    userSkills: join(home, '.joycode', 'skills'),
    projectSkills: join(cwd, '.joycode', 'skills'),
    userPrompts: join(home, '.joycode', 'prompt.json'),
    projectPrompts: join(cwd, '.joycode', 'prompt.json'),
  };
}
