import { describe, expect, it } from 'vitest';

import { AdapterRegistry } from '../../src/adapters/registry.js';
import type {
  AgentAdapter,
  Capabilities,
  CoverageReport,
  DiscoveredTargets,
  OperationResult,
  Scope,
} from '../../src/adapters/types.js';
import type { AgentSelectionPolicy } from '../../src/core/selection.js';

const capabilities: Capabilities = {
  nativeSkillEvents: true,
  skillInjection: false,
  nativeMcpEvents: false,
  stdioMcpProxy: true,
  skillWatching: false,
};

function adapter(id: string): AgentAdapter {
  const result: OperationResult = { status: 'success', message: 'ok' };
  const coverage: CoverageReport = {
    agent: id,
    skills: 'available',
    mcp: 'available',
    issues: [],
  };
  const targets: DiscoveredTargets = {
    agent: id,
    skills: [],
    mcp: [],
    unresolved: [],
    issues: [],
  };

  return {
    id,
    capabilities,
    discover: async () => [],
    listTargets: async () => targets,
    configure: async (_policy: AgentSelectionPolicy) => [result],
    install: async (_scope: Scope) => [result],
    sync: async (_scope: Scope) => [result],
    repair: async (_scope: Scope) => [result],
    uninstall: async (_scope: Scope) => [result],
    health: async () => coverage,
  };
}

describe('AdapterRegistry', () => {
  it('returns adapters in stable registration order', () => {
    const registry = new AdapterRegistry();
    const second = adapter('second');
    const first = adapter('first');

    registry.register(second);
    registry.register(first);

    expect(registry.list()).toEqual([second, first]);
    expect(registry.get('first')).toBe(first);
  });

  it('rejects duplicate adapter ids', () => {
    const registry = new AdapterRegistry();
    registry.register(adapter('codex'));

    expect(() => registry.register(adapter('codex'))).toThrow(
      'Adapter "codex" is already registered',
    );
  });

  it('describes an unknown adapter and the available ids', () => {
    const registry = new AdapterRegistry();
    registry.register(adapter('codex'));

    expect(() => registry.get('missing')).toThrow(
      'Unknown adapter "missing". Available adapters: codex',
    );
  });

  it('describes an empty registry when an adapter is unknown', () => {
    const registry = new AdapterRegistry();

    expect(() => registry.get('missing')).toThrow(
      'Unknown adapter "missing". No adapters are registered',
    );
  });
});
