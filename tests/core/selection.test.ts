import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { usagePaths } from '../../src/core/paths.js';
import {
  emptyAgentSelection,
  emptySelectionConfig,
  loadSelectionConfig,
  matchSelectionPattern,
  saveSelectionConfig,
  selectedMcp,
  selectedSkillMode,
  skillModes,
  type SelectionConfig,
} from '../../src/core/selection.js';

async function temporaryPath(name = 'config.json'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-usage-selection-'));
  return join(directory, name);
}

describe('selection matching', () => {
  it('exports the supported Skill collection modes', () => {
    expect(skillModes).toEqual(['native_hook', 'injected_mcp']);
  });

  it('anchors literal and star patterns', () => {
    expect(matchSelectionPattern('release-*', 'release-prod')).toBe(true);
    expect(matchSelectionPattern('release-*', 'release-')).toBe(true);
    expect(matchSelectionPattern('release-*', 'x-release-prod')).toBe(false);
    expect(matchSelectionPattern('release-*', 'release-prod-extra')).toBe(true);
    expect(matchSelectionPattern('release', 'release-extra')).toBe(false);
  });

  it('matches case-sensitively', () => {
    expect(matchSelectionPattern('Review', 'Review')).toBe(true);
    expect(matchSelectionPattern('Review', 'review')).toBe(false);
  });

  it.each(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])(
    'treats regex metacharacter %s literally',
    (character) => {
      expect(matchSelectionPattern(`a${character}b`, `a${character}b`)).toBe(true);
      expect(matchSelectionPattern(`a${character}b`, 'axb')).toBe(false);
    },
  );

  it('selects nothing from an empty policy', () => {
    const policy = emptyAgentSelection();

    expect(policy).toEqual({
      skills: { native_hook: [], injected_mcp: [] },
      mcp: [],
    });
    expect(selectedSkillMode(policy, 'review')).toBeUndefined();
    expect(selectedMcp(policy, 'github', 'search')).toBe(false);
  });

  it('selects exactly one Skill collection mode', () => {
    const policy = {
      skills: {
        native_hook: ['review'],
        injected_mcp: ['deploy-*'],
      },
      mcp: [],
    };

    expect(selectedSkillMode(policy, 'review')).toBe('native_hook');
    expect(selectedSkillMode(policy, 'deploy-prod')).toBe('injected_mcp');
    expect(selectedSkillMode(policy, 'other')).toBeUndefined();
  });

  it('rejects a Skill matched by both collection modes', () => {
    const policy = {
      skills: {
        native_hook: ['review'],
        injected_mcp: ['rev*'],
      },
      mcp: [],
    };

    expect(() => selectedSkillMode(policy, 'review')).toThrow(
      'Skill "review" matches both native_hook and injected_mcp',
    );
  });

  it('matches an MCP server or its server.tool identifier', () => {
    const policy = {
      skills: { native_hook: [], injected_mcp: [] },
      mcp: ['github', 'fs.read_*'],
    };

    expect(selectedMcp(policy, 'github', 'search')).toBe(true);
    expect(selectedMcp(policy, 'fs', 'read_file')).toBe(true);
    expect(selectedMcp(policy, 'fs', 'write_file')).toBe(false);
    expect(selectedMcp(policy, 'github-enterprise', 'search')).toBe(false);
  });
});

describe('selection persistence', () => {
  it('returns an empty versioned config when the file is missing', async () => {
    const path = await temporaryPath('missing.json');

    await expect(loadSelectionConfig(path)).resolves.toEqual({
      version: 1,
      agents: {},
    });
    expect(emptySelectionConfig()).toEqual({ version: 1, agents: {} });
  });

  it('round-trips a config and deduplicates exact patterns', async () => {
    const path = await temporaryPath();
    const config: SelectionConfig = {
      version: 1,
      agents: {
        codex: {
          skills: {
            native_hook: ['review', 'review'],
            injected_mcp: ['deploy-*'],
          },
          mcp: ['github', 'github'],
        },
      },
    };

    await saveSelectionConfig(path, config);

    await expect(loadSelectionConfig(path)).resolves.toEqual({
      version: 1,
      agents: {
        codex: {
          skills: {
            native_hook: ['review'],
            injected_mcp: ['deploy-*'],
          },
          mcp: ['github'],
        },
      },
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['unsupported version', JSON.stringify({ version: 2, agents: {} })],
    ['invalid policy shape', JSON.stringify({ version: 1, agents: { codex: {} } })],
    [
      'empty selection pattern',
      JSON.stringify({
        version: 1,
        agents: {
          codex: {
            skills: { native_hook: [''], injected_mcp: [] },
            mcp: [],
          },
        },
      }),
    ],
  ])('rejects %s', async (_label, contents) => {
    const path = await temporaryPath();
    await writeFile(path, contents);

    await expect(loadSelectionConfig(path)).rejects.toThrow();
  });

  it('validates save input before creating a parent directory', async () => {
    const root = await temporaryPath('not-created');
    const path = join(root, 'nested', 'config.json');
    const invalid = { version: 2, agents: {} } as unknown as SelectionConfig;

    await expect(saveSelectionConfig(path, invalid)).rejects.toThrow();
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite an existing file when save input is invalid', async () => {
    const path = await temporaryPath();
    const original = `${JSON.stringify(emptySelectionConfig())}\n`;
    await writeFile(path, original);
    const invalid = {
      version: 1,
      agents: {
        codex: {
          skills: { native_hook: [''], injected_mcp: [] },
          mcp: [],
        },
      },
    } as SelectionConfig;

    await expect(saveSelectionConfig(path, invalid)).rejects.toThrow();
    await expect(readFile(path, 'utf8')).resolves.toBe(original);
  });

  it('preserves the destination and cleans the temp file when rename fails', async () => {
    const path = await temporaryPath();
    await mkdir(path);
    const sentinel = join(path, 'sentinel');
    await writeFile(sentinel, 'keep me');

    await expect(
      saveSelectionConfig(path, emptySelectionConfig()),
    ).rejects.toThrow();

    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep me');
    const siblings = await readdir(dirname(path));
    expect(siblings).toEqual(['config.json']);
    expect(
      siblings.filter(
        (name) => name.startsWith('config.json.') && name.endsWith('.tmp'),
      ),
    ).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'writes the final config with exact owner-only permissions',
    async () => {
      const path = await temporaryPath();
      await writeFile(path, 'old config', { mode: 0o644 });
      const previousUmask = process.umask(0o777);

      try {
        await saveSelectionConfig(path, emptySelectionConfig());
      } finally {
        process.umask(previousUmask);
      }

      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );
});

describe('usagePaths', () => {
  it('places the selection config in the shared usage root', () => {
    expect(usagePaths('/tmp/agent-usage').config).toBe(
      '/tmp/agent-usage/config.json',
    );
  });
});
