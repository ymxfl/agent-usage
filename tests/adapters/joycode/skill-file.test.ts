import { describe, expect, it } from 'vitest';

import {
  injectAccountingBlock,
  removeAccountingBlock,
} from '../../../src/adapters/joycode/skill-file.js';

const CRLF_ORIGINAL =
  '---\r\nname: deploy\r\ndescription: Deploy safely\r\n---\r\n\r\n# Deploy\r\nDo work.\r\n';

describe('injectAccountingBlock', () => {
  it('inserts the begin marker after frontmatter and preserves CRLF', () => {
    const { content, changed } = injectAccountingBlock(CRLF_ORIGINAL, 'joycode:deploy');

    expect(changed).toBe(true);
    expect(content).toContain('agent-usage:begin v1');
    expect(content).toContain('agent-usage:end');
    // Begin marker lands after the description line, not above the frontmatter.
    const descIndex = content.indexOf('description: Deploy safely');
    const beginIndex = content.indexOf('<!-- agent-usage:begin v1 -->');
    expect(beginIndex).toBeGreaterThan(descIndex);
    // CRLF line endings preserved.
    expect(content).toContain('\r\n');
    expect(content).toContain('"skill_id":"joycode:deploy"');
  });

  it('is idempotent: re-injecting is a no-op (byte-identical, changed false)', () => {
    const first = injectAccountingBlock(CRLF_ORIGINAL, 'joycode:deploy');
    const second = injectAccountingBlock(first.content, 'joycode:deploy');

    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('round-trips: remove(inject(original)) === original', () => {
    const injected = injectAccountingBlock(CRLF_ORIGINAL, 'joycode:deploy');
    const removed = removeAccountingBlock(injected.content);

    expect(removed.changed).toBe(true);
    expect(removed.content).toBe(CRLF_ORIGINAL);
  });

  it('places the block at the very top when there is no frontmatter', () => {
    const original = '# Deploy\n';
    const { content, changed } = injectAccountingBlock(original, 'joycode:no-fm');

    expect(changed).toBe(true);
    expect(content).toContain('agent-usage:begin v1');
    expect(content).toContain('# Deploy');
    // Block precedes the body.
    expect(content.indexOf('agent-usage:begin v1')).toBeLessThan(
      content.indexOf('# Deploy'),
    );
  });

  it('preserves a UTF-8 BOM and inserts after frontmatter', () => {
    const original = '﻿---\nname: 部署\n---\n正文\n';
    const { content, changed } = injectAccountingBlock(original, 'joycode:bom');

    expect(changed).toBe(true);
    expect(content).toContain('agent-usage:begin v1');
    // BOM kept at the very start.
    expect(content.startsWith('﻿')).toBe(true);
    // Body preserved.
    expect(content).toContain('正文');
    expect(content).toContain('name: 部署');
  });

  it('BOM with no frontmatter round-trips losslessly', () => {
    const original = '﻿# plain\nbody\n';
    const injected = injectAccountingBlock(original, 'joycode:user:x');
    const removed = removeAccountingBlock(injected.content);

    expect(removed.content).toBe(original);
    // BOM survives the round-trip (U+FEFF at offset 0).
    expect(removed.content.charCodeAt(0)).toBe(0xfeff);
  });

  it('BOM with no frontmatter is idempotent', () => {
    const once = injectAccountingBlock('﻿# plain\nbody\n', 'joycode:user:x');
    const twice = injectAccountingBlock(once.content, 'joycode:user:x');

    expect(twice.content).toBe(once.content);
    expect(twice.changed).toBe(false);
  });

  it('handles non-ASCII (CJK) frontmatter and body', () => {
    const original = '---\nname: 发布\n---\n执行。\n';
    const { content, changed } = injectAccountingBlock(original, 'joycode:cjk');

    expect(changed).toBe(true);
    expect(content).toContain('agent-usage:begin v1');
    expect(content).toContain('执行。');
    expect(content).toContain('name: 发布');
  });

  it('replaces a v0 managed block with exactly one v1 block', () => {
    const v0 =
      '---\nname: legacy\n---\n' +
      '<!-- agent-usage:begin v0 -->\nold block line\n<!-- agent-usage:end -->\n\nbody\n';
    const { content, changed } = injectAccountingBlock(v0, 'joycode:upgrade');

    expect(changed).toBe(true);
    // Exactly one v1 begin marker and one end marker.
    expect(content.match(/agent-usage:begin v1/g)).toHaveLength(1);
    expect(content.match(/agent-usage:end/g)).toHaveLength(1);
    // The v0 marker is gone.
    expect(content).not.toContain('agent-usage:begin v0');
    expect(content).not.toContain('old block line');
    expect(content).toContain('body');
  });

  it('throws on an unterminated managed block', () => {
    expect(() =>
      injectAccountingBlock('<!-- agent-usage:begin v1 -->\nbroken', 'id'),
    ).toThrow('Malformed');
  });

  it('reflects the latest skill id when re-injected with a different id', () => {
    const original = '---\nname: swap\n---\nbody\n';
    const first = injectAccountingBlock(original, 'joycode:a');
    const second = injectAccountingBlock(first.content, 'joycode:b');

    expect(second.changed).toBe(true);
    expect(second.content).toContain('"skill_id":"joycode:b"');
    expect(second.content).not.toContain('"skill_id":"joycode:a"');
    // Still exactly one block.
    expect(second.content.match(/agent-usage:begin v1/g)).toHaveLength(1);
  });
});

describe('removeAccountingBlock', () => {
  it('is a no-op when no block is present', () => {
    const result = removeAccountingBlock('---\nname: x\n---\nbody\n');
    expect(result.changed).toBe(false);
    expect(result.content).toBe('---\nname: x\n---\nbody\n');
  });

  it('throws on a begin marker with no end marker', () => {
    expect(() =>
      removeAccountingBlock('text\n<!-- agent-usage:begin v1 -->\nmore'),
    ).toThrow('Malformed');
  });
});
