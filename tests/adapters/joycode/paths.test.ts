import { describe, expect, it } from 'vitest';

import { joyCodePaths } from '../../../src/adapters/joycode/paths.js';

describe('joyCodePaths', () => {
  it('composes the user and project joycode configuration paths', () => {
    const paths = joyCodePaths('/Users/me', '/work/app');

    expect(paths).toEqual({
      userMcp: '/Users/me/.joycode/joycode-mcp.json',
      projectMcp: '/work/app/.joycode/mcp.json',
      userSkills: '/Users/me/.joycode/skills',
      projectSkills: '/work/app/.joycode/skills',
      userPrompts: '/Users/me/.joycode/prompt.json',
      projectPrompts: '/work/app/.joycode/prompt.json',
    });
  });

  it('uses the supplied home and cwd verbatim (no environment reads)', () => {
    const paths = joyCodePaths('/home/a', '/projects/b');

    expect(paths.userMcp).toBe('/home/a/.joycode/joycode-mcp.json');
    expect(paths.projectMcp).toBe('/projects/b/.joycode/mcp.json');
    expect(paths.userSkills).toBe('/home/a/.joycode/skills');
    expect(paths.projectSkills).toBe('/projects/b/.joycode/skills');
    expect(paths.userPrompts).toBe('/home/a/.joycode/prompt.json');
    expect(paths.projectPrompts).toBe('/projects/b/.joycode/prompt.json');
  });
});
