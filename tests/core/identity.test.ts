import { describe, expect, it } from 'vitest';

import {
  injectedDedupeKey,
  nativeDedupeKey,
  proxyDedupeKey,
  stableSkillId,
} from '../../src/core/identity.js';

describe('stableSkillId', () => {
  it('returns a deterministic scoped identifier with a 16-character SHA-256 suffix', () => {
    const first = stableSkillId('codex', 'project', '/repo/.codex/skills/testing');
    const second = stableSkillId('codex', 'project', '/repo/.codex/skills/testing');

    expect(first).toBe(second);
    expect(first).toMatch(/^codex:project:[0-9a-f]{16}$/);
  });

  it('does not expose the canonical path', () => {
    const canonicalPath = '/Users/alice/private-project/.codex/skills/testing';

    expect(stableSkillId('codex', 'user', canonicalPath)).not.toContain(canonicalPath);
  });

  it('returns different identifiers for different scopes', () => {
    const canonicalPath = '/repo/.codex/skills/testing';

    expect(stableSkillId('codex', 'user', canonicalPath)).not.toBe(
      stableSkillId('codex', 'project', canonicalPath),
    );
  });
});

describe('dedupe keys', () => {
  it('formats native hook keys', () => {
    expect(nativeDedupeKey('codex', 'tool-use-123')).toBe(
      'codex:native:tool-use-123',
    );
  });

  it('formats injected MCP keys', () => {
    expect(
      injectedDedupeKey(
        'connection-123',
        'codex:project:0123456789abcdef',
      ),
    ).toBe('injected:connection-123:codex:project:0123456789abcdef');
  });

  it('formats MCP proxy keys', () => {
    expect(proxyDedupeKey('connection-123', 'request-456')).toBe(
      'proxy:connection-123:request-456',
    );
  });
});
