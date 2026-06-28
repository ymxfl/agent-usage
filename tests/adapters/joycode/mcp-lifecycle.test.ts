import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJoyCodeAdapter } from '../../../src/adapters/joycode/adapter.js';
import { joyCodePaths } from '../../../src/adapters/joycode/paths.js';
import type { McpLifecycle } from '../../../src/mcp/server.js';
import type { UsageMcpService } from '../../../src/mcp/service.js';

const SKILL_WITH_FM = `---
name: deploy
description: Deploy safely
---

# Deploy

Do work.
`;

const RUNTIME_BUNDLE = Buffer.from('#!/usr/bin/env node\nruntime\n');
const tempDirectories: string[] = [];

interface Fixture {
  home: string;
  cwd: string;
  usageStateDir: string;
  selectionConfigPath: string;
  paths: ReturnType<typeof joyCodePaths>;
  adapter: ReturnType<typeof createJoyCodeAdapter>;
}

function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'agent-usage-joycode-mcp-'));
  tempDirectories.push(home);
  const cwd = mkdtempSync(join(tmpdir(), 'agent-usage-joycode-mcp-cwd-'));
  tempDirectories.push(cwd);
  const usageStateDir = join(home, 'state');
  const selectionConfigPath = join(home, 'config.json');
  const paths = joyCodePaths(home, cwd);
  return {
    home,
    cwd,
    usageStateDir,
    selectionConfigPath,
    paths,
    adapter: createJoyCodeAdapter({
      home,
      cwd,
      usageStateDir,
      selectionConfigPath,
      runtimeBundle: RUNTIME_BUNDLE,
    }),
  };
}

afterEach(async () => {
  for (const directory of tempDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('JoyCode adapter MCP lifecycle (skillWatching wiring)', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  it('exposes createMcpLifecycle() returning a handle that starts watching and closes cleanly', async () => {
    const { adapter, paths, usageStateDir } = fixture;
    // Pre-existing skill present before the session starts.
    await mkdir(paths.userSkills, { recursive: true });
    const skillDir = join(paths.userSkills, 'alpha');
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, 'SKILL.md');
    writeFileSync(skillFile, SKILL_WITH_FM, 'utf8');
    const canonical = realpathSync(skillFile);

    expect(typeof adapter.createMcpLifecycle).toBe('function');

    const lifecycle = await adapter.createMcpLifecycle?.();
    expect(lifecycle).toBeDefined();
    const handle = lifecycle as McpLifecycle;

    try {
      await handle.start();
      // start() runs the reconciler's initial sync(): the pre-existing skill is
      // instrumented (skillWatching is delivered during the live session).
      const instrumented = await readFile(canonical, 'utf8');
      expect(instrumented).toContain('agent-usage:begin v2');

      const stateFile = join(usageStateDir, 'joycode-skill-manifest.json');
      const manifest = JSON.parse(await readFile(stateFile, 'utf8')) as {
        skills: Record<string, unknown>;
      };
      expect(manifest.skills[canonical]).toBeDefined();
    } finally {
      // close() must resolve (no leaked watcher handles).
      await expect(handle.close()).resolves.toBeUndefined();
    }
  });

  it('createMcpLifecycle() observes a skill created during the session', async () => {
    const { adapter, paths, usageStateDir } = fixture;
    await mkdir(paths.userSkills, { recursive: true });

    const handle = (await adapter.createMcpLifecycle?.()) as McpLifecycle;
    try {
      await handle.start();
      // Let the FS backend arm after the ready signal.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const skillDir = join(paths.userSkills, 'beta');
      mkdirSync(skillDir, { recursive: true });
      const created = join(skillDir, 'SKILL.md');
      writeFileSync(created, SKILL_WITH_FM, 'utf8');
      const canonical = realpathSync(created);

      const stateFile = join(usageStateDir, 'joycode-skill-manifest.json');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const manifest = JSON.parse(await readFile(stateFile, 'utf8')) as {
          skills: Record<string, unknown>;
        };
        if (manifest.skills[canonical] !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const manifest = JSON.parse(await readFile(stateFile, 'utf8')) as {
        skills: Record<string, unknown>;
      };
      expect(manifest.skills[canonical]).toBeDefined();
    } finally {
      await handle.close();
    }
  }, 15000);

  it('close() leaves no active watcher: a later skill is not instrumented', async () => {
    const { adapter, paths } = fixture;
    await mkdir(paths.userSkills, { recursive: true });

    const handle = (await adapter.createMcpLifecycle?.()) as McpLifecycle;
    await handle.start();
    await handle.close();

    const skillDir = join(paths.userSkills, 'after-close');
    mkdirSync(skillDir, { recursive: true });
    const created = join(skillDir, 'SKILL.md');
    writeFileSync(created, SKILL_WITH_FM, 'utf8');

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await readFile(created, 'utf8')).not.toContain('agent-usage:begin v2');
  });

  it('the CLI mcp command passes the JoyCode lifecycle to runMcpServer', async () => {
    // Mock runMcpServer to capture the lifecycle without spawning a real stdio
    // server, and start()/close() it so the watcher is exercised end-to-end.
    const captured: { lifecycle: McpLifecycle | undefined } = {
      lifecycle: undefined,
    };
    const { createProgram } = await import('../../../src/cli.js');
    const { AdapterRegistry } = await import('../../../src/adapters/registry.js');

    const runMcpServer = vi.fn(
      async (_service: UsageMcpService, lifecycle?: McpLifecycle) => {
        captured.lifecycle = lifecycle;
        await lifecycle?.start();
        await lifecycle?.close();
      },
    );

    const registry = new AdapterRegistry();
    registry.register(fixture.adapter);

    await createProgram(
      registry,
      {
        paths: () => ({
          root: fixture.home,
          config: fixture.selectionConfigPath,
          database: join(fixture.home, 'usage.db'),
          state: fixture.usageStateDir,
          errors: join(fixture.home, 'errors.log'),
        }),
        openDatabase: () => ({ close() {}, prepare() { throw new Error('unused'); } }) as never,
        createRepository: () =>
          ({ insert: () => true, report: () => ({ rangeLabel: 'all', totals: [], topSkills: [], mcp: [], warnings: [] }) }) as never,
        runMcpServer,
        randomId: () => 'fixed',
        logger: { error() {}, log() {}, warn() {}, info() {}, debug() {} } as never,
        writeOutput: () => {},
        writeError: () => {},
        setExitCode: () => {},
      },
    ).parseAsync(['node', 'agent-usage', 'mcp', '--agent', 'joycode']);

    expect(runMcpServer).toHaveBeenCalledOnce();
    expect(captured.lifecycle).toBeDefined();
    expect(typeof captured.lifecycle?.start).toBe('function');
    expect(typeof captured.lifecycle?.close).toBe('function');
  });
});
