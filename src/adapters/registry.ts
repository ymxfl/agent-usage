import type { AgentAdapter } from './types.js';

export class AdapterRegistry {
  readonly #adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Adapter "${adapter.id}" is already registered`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter {
    const adapter = this.#adapters.get(id);
    if (adapter !== undefined) return adapter;

    const available = [...this.#adapters.keys()];
    const suffix = available.length === 0
      ? 'No adapters are registered'
      : `Available adapters: ${available.join(', ')}`;
    throw new Error(`Unknown adapter "${id}". ${suffix}`);
  }

  list(): AgentAdapter[] {
    return [...this.#adapters.values()];
  }
}
