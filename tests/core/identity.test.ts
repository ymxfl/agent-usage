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
    expect(first).toBe('codex:project:a35a0f14a2e189d4');
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

  it('returns different identifiers for different agents', () => {
    const canonicalPath = '/repo/.codex/skills/testing';

    expect(stableSkillId('codex', 'project', canonicalPath)).not.toBe(
      stableSkillId('claude-code', 'project', canonicalPath),
    );
  });

  it('returns different identifiers for different canonical paths', () => {
    expect(
      stableSkillId('codex', 'project', '/repo/.codex/skills/testing'),
    ).not.toBe(
      stableSkillId('codex', 'project', '/repo/.codex/skills/debugging'),
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
        1,
      ),
    ).toBe('injected:connection-123:codex:project:0123456789abcdef:1');
  });

  it('formats MCP proxy keys', () => {
    expect(proxyDedupeKey('connection-123', 'request-456', 1)).toBe(
      'proxy:connection-123:"request-456":1',
    );
  });

  it('formats numeric MCP proxy request IDs', () => {
    expect(proxyDedupeKey('connection-123', 456, 1)).toBe(
      'proxy:connection-123:456:1',
    );
  });

  it('distinguishes numeric proxy request IDs from numeric strings', () => {
    expect(proxyDedupeKey('connection-123', 456, 1)).not.toBe(
      proxyDedupeKey('connection-123', '456', 1),
    );
  });

  it('distinguishes repeated injected and proxy calls', () => {
    expect(
      injectedDedupeKey('connection-123', 'codex:project:skill', 1),
    ).not.toBe(
      injectedDedupeKey('connection-123', 'codex:project:skill', 2),
    );
    expect(proxyDedupeKey('connection-123', 'request-456', 1)).not.toBe(
      proxyDedupeKey('connection-123', 'request-456', 2),
    );
  });
});
