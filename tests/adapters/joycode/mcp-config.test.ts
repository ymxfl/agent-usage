import { describe, expect, it } from 'vitest';

import {
  instrumentJoyCodeMcpConfig,
  restoreJoyCodeMcpConfig,
  type JoyCodeMcpConfig,
} from '../../../src/adapters/joycode/mcp-config.js';

const runtimePath = '/usr/local/bin/agent-usage';

function stdioEntry(command: string, args: string[] = []): JoyCodeMcpConfig {
  return {
    unrelated: true,
    mcpServers: {
      filesystem: { command, args },
    },
  };
}

describe('instrumentJoyCodeMcpConfig', () => {
  it('preserves siblings, skips usage-stats, wraps each stdio command once, keeps env, and leaves remote url entries untouched', () => {
    const input: JoyCodeMcpConfig = {
      unrelated: true,
      mcpServers: {
        filesystem: { command: 'npx', args: ['fs-server'], env: { ROOT: '/x' } },
        remote: { url: 'https://example.test/mcp' },
      },
    };

    const { config, manifest } = instrumentJoyCodeMcpConfig(input, runtimePath);

    expect(config.unrelated).toBe(true);
    const servers = config.mcpServers as Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    // usage-stats accounting entry registered
    expect(servers['usage-stats']).toEqual({
      command: process.execPath,
      args: [runtimePath, 'mcp', '--agent', 'joycode'],
    });
    // filesystem wrapped through the proxy, env preserved
    expect(servers.filesystem).toEqual({
      command: process.execPath,
      args: [
        runtimePath,
        'proxy',
        '--agent',
        'joycode',
        '--server',
        'filesystem',
        '--',
        'npx',
        'fs-server',
      ],
      env: { ROOT: '/x' },
    });
    // remote url entry untouched (not wrapped)
    expect(servers.remote).toEqual({ url: 'https://example.test/mcp' });
    // original filesystem recorded, remote NOT recorded
    expect(manifest.originals.filesystem).toEqual({
      command: 'npx',
      args: ['fs-server'],
      env: { ROOT: '/x' },
    });
    expect(manifest.originals.remote).toBeUndefined();
    expect(manifest.managedHashes.remote).toBeUndefined();
    expect(manifest.managedHashes.filesystem).toEqual(expect.any(String));
  });

  it('is idempotent (running on an already-instrumented config yields the same config, no double-wrap, no duplicate usage-stats)', () => {
    const input = stdioEntry('npx', ['server']);
    const first = instrumentJoyCodeMcpConfig(input, runtimePath);
    const second = instrumentJoyCodeMcpConfig(first.config, runtimePath);
    // config is unchanged on the second pass (no double-wrap, single usage-stats)
    expect(second.config).toEqual(first.config);
    // already-wrapped entry is not re-recorded in the manifest
    expect(second.manifest.originals).toEqual({});
    expect(second.manifest.managedHashes).toEqual({});
  });

  it('creates mcpServers when missing (still adds usage-stats, wraps nothing)', () => {
    const input: JoyCodeMcpConfig = { unrelated: true };
    const { config, manifest } = instrumentJoyCodeMcpConfig(input, runtimePath);
    expect(config.unrelated).toBe(true);
    const servers = config.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers['usage-stats']).toEqual({
      command: process.execPath,
      args: [runtimePath, 'mcp', '--agent', 'joycode'],
    });
    expect(manifest.originals).toEqual({});
    expect(manifest.managedHashes).toEqual({});
  });

  it('does not double-wrap an already-wrapped entry', () => {
    const input: JoyCodeMcpConfig = {
      mcpServers: {
        filesystem: {
          command: process.execPath,
          args: [
            runtimePath,
            'proxy',
            '--agent',
            'joycode',
            '--server',
            'filesystem',
            '--',
            'npx',
            'fs-server',
          ],
        },
      },
    };
    const { config, manifest } = instrumentJoyCodeMcpConfig(input, runtimePath);
    const servers = config.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers.filesystem?.args).toEqual(input.mcpServers?.filesystem?.args);
    // not recorded as managed (it was already wrapped, not freshly wrapped)
    expect(manifest.originals.filesystem).toBeUndefined();
    expect(manifest.managedHashes.filesystem).toBeUndefined();
  });

  it('does not mutate the input object', () => {
    const input = stdioEntry('npx', ['server']);
    const snapshot: JoyCodeMcpConfig = {
      unrelated: true,
      mcpServers: { filesystem: { command: 'npx', args: ['server'] } },
    };
    instrumentJoyCodeMcpConfig(input, runtimePath);
    expect(input).toEqual(snapshot);
  });

  it('produces stable hashes for structurally-equal entries', () => {
    const a = instrumentJoyCodeMcpConfig(stdioEntry('npx', ['server']), runtimePath);
    const b = instrumentJoyCodeMcpConfig(stdioEntry('npx', ['server']), runtimePath);
    expect(a.manifest.managedHashes.filesystem).toBe(b.manifest.managedHashes.filesystem);
  });
});

describe('restoreJoyCodeMcpConfig', () => {
  it('restores an unmodified managed config to the original', () => {
    const original: JoyCodeMcpConfig = {
      unrelated: true,
      mcpServers: {
        filesystem: { command: 'npx', args: ['fs-server'], env: { ROOT: '/x' } },
        remote: { url: 'https://example.test/mcp' },
      },
    };
    const { config, manifest } = instrumentJoyCodeMcpConfig(original, runtimePath);
    const restored = restoreJoyCodeMcpConfig(config, manifest);
    expect(restored).toEqual(original);
  });

  it('throws (without overwriting) when a managed entry was edited by the user', () => {
    const original: JoyCodeMcpConfig = {
      mcpServers: {
        filesystem: { command: 'npx', args: ['fs-server'] },
      },
    };
    const { config, manifest } = instrumentJoyCodeMcpConfig(original, runtimePath);
    // user edits the managed entry
    const edited = {
      ...config,
      mcpServers: {
        ...config.mcpServers,
        filesystem: {
          ...(config.mcpServers?.filesystem as { command: string; args: string[] }),
          args: ['tampered'],
        },
      },
    };
    expect(() => restoreJoyCodeMcpConfig(edited, manifest)).toThrow(/filesystem/);
    // the user's edit is NOT overwritten
    expect(edited.mcpServers?.filesystem?.args).toEqual(['tampered']);
  });

  it('removes the usage-stats accounting entry', () => {
    const original: JoyCodeMcpConfig = {
      mcpServers: { filesystem: { command: 'npx', args: ['server'] } },
    };
    const { config, manifest } = instrumentJoyCodeMcpConfig(original, runtimePath);
    const restored = restoreJoyCodeMcpConfig(config, manifest);
    expect(restored.mcpServers?.['usage-stats']).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const original: JoyCodeMcpConfig = {
      mcpServers: { filesystem: { command: 'npx', args: ['server'] } },
    };
    const { config, manifest } = instrumentJoyCodeMcpConfig(original, runtimePath);
    const snapshot = JSON.parse(JSON.stringify(config)) as JoyCodeMcpConfig;
    restoreJoyCodeMcpConfig(config, manifest);
    expect(config).toEqual(snapshot);
  });
});
