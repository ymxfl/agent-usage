import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { AdapterRegistry } from '../../src/adapters/registry.js';
import type {
  AgentAdapter,
  Capabilities,
  CoverageReport,
  DiscoveredTargets,
  OperationResult,
  Scope,
} from '../../src/adapters/types.js';
import { openUsageDatabase } from '../../src/core/database.js';
import { usagePaths } from '../../src/core/paths.js';
import {
  loadSelectionConfig,
  saveSelectionConfig,
} from '../../src/core/selection.js';
import { UsageRepository } from '../../src/core/repository.js';
import type { CliRuntime } from '../../src/cli.js';
import { startAgentUsageWebServer } from '../../src/web/server.js';
import { usageEvent } from '../helpers/usage-fixtures.js';

const temporaryDirectories: string[] = [];

const capabilities: Capabilities = {
  nativeSkillEvents: true,
  skillInjection: true,
  nativeMcpEvents: true,
  stdioMcpProxy: true,
  skillWatching: false,
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-usage-web-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function runtimeFixture(root: string): CliRuntime {
  return {
    paths: () => usagePaths(root),
    loadSelectionConfig,
    saveSelectionConfig,
    openDatabase: openUsageDatabase,
    createRepository: (database) => new UsageRepository(database as DatabaseSync),
    runMcpServer: async () => {},
    runProxy: async () => ({ code: 0, signal: null }),
    cwd: () => root,
    env: {},
    randomId: () => 'id',
    writeOutput: () => {},
    writeError: () => {},
    setExitCode: () => {},
    signalSelf: () => {},
    isTTY: () => false,
    language: () => 'en',
    prompt: async () => '',
    select: async (_message, choices) => choices[0]!.value,
    multiSelect: async () => [],
    confirm: async () => true,
    purgeData: () => {},
    logger: console,
    readStdin: async () => '',
    appendError: async () => {},
  };
}

function ok(message = 'ok'): OperationResult[] {
  return [{ status: 'success', message }];
}

function adapterWithTargets(targets: DiscoveredTargets): AgentAdapter {
  const health: CoverageReport = {
    agent: targets.agent,
    skills: 'ok',
    mcp: 'ok',
    issues: [],
  };
  return {
    id: targets.agent,
    capabilities,
    discover: async () => [],
    listTargets: async () => targets,
    configure: async () => ok(),
    install: async (_scope: Scope) => ok(),
    sync: async (_scope: Scope) => ok(),
    repair: async (_scope: Scope) => ok(),
    uninstall: async (_scope: Scope) => ok(),
    health: async () => health,
  };
}

describe('agent usage web server', () => {
  it('receives local webhook events and streams them to the browser', async () => {
    const root = await temporaryDirectory();
    const server = await startAgentUsageWebServer({
      registry: new AdapterRegistry(),
      runtime: runtimeFixture(root),
      host: '127.0.0.1',
      port: 0,
    });
    const abort = new AbortController();

    try {
      const stream = await fetch(`${server.url}/api/events`, {
        signal: abort.signal,
      });
      expect(stream.ok).toBe(true);
      const reader = stream.body!.getReader();

      const event = usageEvent({ agent: 'joycode' });
      const post = await fetch(`${server.url}/webhook/usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'usage_event', event }),
      });
      expect(post.status).toBe(202);

      const decoder = new TextDecoder();
      let text = '';
      for (let index = 0; index < 10 && !text.includes('joycode'); index += 1) {
        const chunk = await reader.read();
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).toContain('event: usage');
      expect(text).toContain('joycode');
    } finally {
      abort.abort();
      await server.close();
    }
  });

  it('can configure the local webhook URL in the shared config file', async () => {
    const root = await temporaryDirectory();
    const server = await startAgentUsageWebServer({
      registry: new AdapterRegistry(),
      runtime: runtimeFixture(root),
      host: '127.0.0.1',
      port: 0,
    });

    try {
      const response = await fetch(`${server.url}/api/webhook/local`, {
        method: 'POST',
      });

      expect(response.ok).toBe(true);
      await expect(readFile(usagePaths(root).config, 'utf8')).resolves.toContain(
        `${server.url}/webhook/usage`,
      );
    } finally {
      await server.close();
    }
  });

  it('returns enabled Skills and MCP servers before disabled targets', async () => {
    const root = await temporaryDirectory();
    const registry = new AdapterRegistry();
    registry.register(
      adapterWithTargets({
        agent: 'codex',
        skills: [
          {
            name: 'disabled-skill',
            scope: 'user',
            path: '/tmp/disabled/SKILL.md',
            supportedModes: ['injected_mcp'],
          },
          {
            name: 'enabled-skill',
            scope: 'user',
            path: '/tmp/enabled/SKILL.md',
            supportedModes: ['injected_mcp'],
            selectedMode: 'injected_mcp',
          },
        ],
        mcp: [
          {
            server: 'disabled-mcp',
            scope: 'user',
            transport: 'stdio',
            selected: false,
          },
          {
            server: 'enabled-mcp',
            scope: 'user',
            transport: 'stdio',
            selected: true,
          },
        ],
        unresolved: [],
        issues: [],
      }),
    );
    const server = await startAgentUsageWebServer({
      registry,
      runtime: runtimeFixture(root),
      host: '127.0.0.1',
      port: 0,
    });

    try {
      const response = await fetch(`${server.url}/api/state`);
      const body = await response.json() as {
        agents: Array<{ targets: DiscoveredTargets }>;
      };

      expect(body.agents[0]!.targets.skills.map((skill) => skill.name)).toEqual([
        'enabled-skill',
        'disabled-skill',
      ]);
      expect(body.agents[0]!.targets.mcp.map((server) => server.server)).toEqual([
        'enabled-mcp',
        'disabled-mcp',
      ]);
    } finally {
      await server.close();
    }
  });

  it('serves a Chinese console with navigation, confirmations, operation results, and table reports', async () => {
    const root = await temporaryDirectory();
    const server = await startAgentUsageWebServer({
      registry: new AdapterRegistry(),
      runtime: runtimeFixture(root),
      host: '127.0.0.1',
      port: 0,
    });

    try {
      const response = await fetch(server.url);
      const html = await response.text();

      expect(html).toContain('id="operation-status"');
      expect(html).toContain('confirm(');
      expect(html).toContain('data-view-target="overview"');
      expect(html).toContain('总览');
      expect(html).toContain('智能体');
      expect(html).toContain('报表');
      expect(html).toContain('实时上报');
      expect(html).toContain('id="report-totals"');
      expect(html).toContain('id="report-skills"');
      expect(html).toContain('id="report-mcp"');
      expect(html).toContain('id="report-warnings"');
      expect(html).toContain("'智能体','类型'");
      expect(html).toContain("'工具','尝试'");
      expect(html).toContain('select.mode-select');
      expect(html).toContain('mode-native-hook');
      expect(html).toContain('mode-injected-mcp');
      expect(html).toContain('本地 webhook');
      expect(html).not.toContain('>Agents<');
      expect(html).not.toContain('>Report<');
    } finally {
      await server.close();
    }
  });
});
