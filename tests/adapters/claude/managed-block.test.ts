import { describe, expect, it } from 'vitest';

import {
  MANAGED_BLOCK_VERSION,
  accountingBlock,
  hasManagedBlock,
  injectManagedBlock,
  removeManagedBlock,
} from '../../../src/adapters/claude/managed-block.js';

describe('MANAGED_BLOCK_VERSION', () => {
  it('is pinned to v1', () => {
    expect(MANAGED_BLOCK_VERSION).toBe(1);
  });
});

describe('accountingBlock', () => {
  it('embeds the begin/end markers and the skill id', () => {
    const block = accountingBlock('claude-code:user:abc');

    expect(block).toContain('<!-- agent-usage:begin v1 -->');
    expect(block).toContain('<!-- agent-usage:end -->');
    expect(block).toContain('"skill_id":"claude-code:user:abc"');
  });

  it('references the record_skill tool on the usage-stats MCP server', () => {
    const block = accountingBlock('codex:project:deadbeef');

    expect(block).toContain('`record_skill`');
    expect(block).toContain('`usage-stats`');
  });

  it('asks the agent to record every activation without a session limit', () => {
    const block = accountingBlock('codex:project:deadbeef');

    expect(block).toContain('Every time this skill is activated');
    expect(block).not.toContain('exactly once');
    expect(block).not.toContain('again in this session');
  });

  it('includes the v1 version marker exactly once', () => {
    const block = accountingBlock('a:b:c');
    expect(block.match(/agent-usage:begin v1/g)).toHaveLength(1);
    expect(block.match(/agent-usage:end/g)).toHaveLength(1);
  });
});

describe('hasManagedBlock', () => {
  it('is false for plain content', () => {
    expect(hasManagedBlock('# Just a heading\n\nbody')).toBe(false);
  });

  it('is true once a block has been injected', () => {
    const content = injectManagedBlock('# Skill\n\nbody', 'x:y:z');
    expect(hasManagedBlock(content)).toBe(true);
  });

  it('is false again after removing the block', () => {
    const content = injectManagedBlock('# Skill\n\nbody', 'x:y:z');
    expect(hasManagedBlock(removeManagedBlock(content))).toBe(false);
  });

  it('does not match a partial begin marker without an end', () => {
    expect(hasManagedBlock('<!-- agent-usage:begin v1 -->\nno end here')).toBe(
      false,
    );
  });
});

describe('injectManagedBlock', () => {
  it('places the block at the very top for a file without frontmatter', () => {
    const original = '# My Skill\n\nDoes things.\n';
    const injected = injectManagedBlock(original, 'a:b:c');

    expect(injected.startsWith(accountingBlock('a:b:c'))).toBe(true);
    // body preserved verbatim after the block
    expect(injected).toContain('# My Skill\n\nDoes things.\n');
  });

  it('inserts the block immediately after frontmatter and keeps the body intact', () => {
    const original = '---\ntitle: Demo\n---\n# My Skill\n\nBody.\n';
    const injected = injectManagedBlock(original, 'a:b:c');

    // Frontmatter stays at the top, untouched.
    expect(injected.startsWith('---\ntitle: Demo\n---\n')).toBe(true);
    // Block comes right after the closing delimiter (with separating blank line).
    expect(injected).toBe(
      `---\ntitle: Demo\n---\n\n${accountingBlock('a:b:c')}# My Skill\n\nBody.\n`,
    );
  });

  it('is byte-identical when injected twice with the same skill id', () => {
    const original = '---\nname: demo\n---\n# Skill\n\nbody\n';
    const once = injectManagedBlock(original, 'a:b:c');
    const twice = injectManagedBlock(once, 'a:b:c');

    expect(twice).toBe(once);
  });

  it('is idempotent for files without frontmatter', () => {
    const original = '# Skill\nbody\n';
    const once = injectManagedBlock(original, 'a:b:c');
    const twice = injectManagedBlock(once, 'a:b:c');

    expect(twice).toBe(once);
  });

  it('replaces an existing block when injecting with a different skill id', () => {
    const original = '# Skill\n\nbody\n';
    const first = injectManagedBlock(original, 'alpha:scope:1');
    const second = injectManagedBlock(first, 'beta:scope:2');

    // Exactly one block remains, carrying the new id.
    expect(second.match(/agent-usage:begin v1/g)).toHaveLength(1);
    expect(second).toContain('"skill_id":"beta:scope:2"');
    expect(second).not.toContain('"skill_id":"alpha:scope:1"');
  });

  it('treats a body horizontal rule (---) as body, not frontmatter', () => {
    // The closing frontmatter delimiter is the SECOND standalone --- line at
    // the start of the file. A later --- (horizontal rule) must not be
    // mistaken for frontmatter.
    const original = '---\ntitle: Demo\n---\n\nintro\n\n---\n\nafter rule\n';
    const injected = injectManagedBlock(original, 'a:b:c');

    expect(injected.startsWith('---\ntitle: Demo\n---\n\n')).toBe(true);
    expect(injected).toContain(accountingBlock('a:b:c'));
    // The body horizontal rule survives intact.
    expect(injected).toContain('intro\n\n---\n\nafter rule\n');
    // Only one managed block region.
    expect(injected.match(/agent-usage:begin v1/g)).toHaveLength(1);
  });

  it('does not treat a single leading --- without a closer as frontmatter', () => {
    const original = '---\nnot really frontmatter\nstill body\n';
    const injected = injectManagedBlock(original, 'a:b:c');

    // No closing delimiter => treated as body; block goes at the very top.
    expect(injected.startsWith(accountingBlock('a:b:c'))).toBe(true);
    expect(injected).toContain('---\nnot really frontmatter\nstill body\n');
  });

  it('preserves body content byte-for-byte outside the block', () => {
    const body = 'Some text with `code` and a list:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n';
    const injected = injectManagedBlock(body, 'a:b:c');
    expect(injected.endsWith(body)).toBe(true);
  });

  it('round-trips when the body begins with a blank line after frontmatter', () => {
    const original = '---\ntitle: T\n---\n\npara1\n\n---\n\npara2\n';
    const injected = injectManagedBlock(original, 'x:y:z');
    expect(removeManagedBlock(injected)).toBe(original);
  });

  it('round-trips when the body is empty (frontmatter only)', () => {
    const original = '---\nname: x\n---\n';
    const injected = injectManagedBlock(original, 'a:b:c');
    expect(hasManagedBlock(injected)).toBe(true);
    expect(removeManagedBlock(injected)).toBe(original);
  });

  it('round-trips when the body is a lone horizontal rule after frontmatter', () => {
    const original = '---\na: 1\n---\n\n---\n';
    const injected = injectManagedBlock(original, 'a:b:c');
    expect(removeManagedBlock(injected)).toBe(original);
    expect(injected.match(/agent-usage:begin v1/g)).toHaveLength(1);
  });

  it('places the block AFTER CRLF frontmatter (not at the top) and round-trips losslessly', () => {
    // A SKILL.md saved on Windows uses CRLF line endings. The opening
    // frontmatter delimiter is `---\r\n`, which the splitter must still
    // recognize so the managed block lands after the closing delimiter.
    const original = '---\r\ntitle: Demo\r\n---\r\n# My Skill\r\n\r\nBody.\r\n';
    const injected = injectManagedBlock(original, 'a:b:c');

    // Frontmatter stays at the very top (still starts with `---\r\n`).
    expect(injected.startsWith('---\r\n')).toBe(true);
    // The block must NOT be at the very top: it appears after the closing
    // frontmatter delimiter.
    expect(injected.startsWith(accountingBlock('a:b:c'))).toBe(false);
    // The block is present somewhere after the frontmatter.
    expect(hasManagedBlock(injected)).toBe(true);
    // The injected content preserves the CRLF body intact.
    expect(injected).toContain('# My Skill\r\n\r\nBody.\r\n');
    // Exactly one managed block region.
    expect(injected.match(/agent-usage:begin v1/g)).toHaveLength(1);

    // Lossless round-trip back to the original CRLF content.
    expect(removeManagedBlock(injected)).toBe(original);
  });
});

describe('removeManagedBlock', () => {
  it('round-trips for a file with frontmatter', () => {
    const original = '---\ntitle: Demo\n---\n# Skill\n\nBody.\n';
    const injected = injectManagedBlock(original, 'a:b:c');

    expect(removeManagedBlock(injected)).toBe(original);
  });

  it('round-trips for a file without frontmatter', () => {
    const original = '# Skill\n\nbody line\n';
    const injected = injectManagedBlock(original, 'a:b:c');

    expect(removeManagedBlock(injected)).toBe(original);
  });

  it('is a no-op on content that never had a block', () => {
    const original = '# Skill\n\nbody\n';
    expect(removeManagedBlock(original)).toBe(original);
  });

  it('does not leave a double blank line after frontmatter', () => {
    const original = '---\ntitle: Demo\n---\n# Skill\n';
    const injected = injectManagedBlock(original, 'a:b:c');
    const removed = removeManagedBlock(injected);

    expect(removed).toBe(original);
    expect(removed).not.toContain('---\n\n\n#');
  });

  it('removes a block that was not at the canonical frontmatter position', () => {
    // Block injected somewhere mid-body (e.g. by an older injector variant).
    const content = `# Skill\n\n${accountingBlock('a:b:c')}\n\nmore body\n`;
    const removed = removeManagedBlock(content);

    expect(removed).toBe('# Skill\n\nmore body\n');
    expect(hasManagedBlock(removed)).toBe(false);
  });

  it('handles CRLF content without corrupting the surrounding body', () => {
    const original = '# Skill\r\n\r\nbody\r\n';
    const injected = injectManagedBlock(original, 'a:b:c');
    const removed = removeManagedBlock(injected);

    // The body's existing CRLF line endings are preserved.
    expect(removed.endsWith('# Skill\r\n\r\nbody\r\n')).toBe(true);
    expect(hasManagedBlock(removed)).toBe(false);
  });
});
