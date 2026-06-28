/**
 * Pure helpers for injecting an idempotent "managed accounting block" into a
 * Claude Code Skill's `SKILL.md`. The block instructs the model to call the
 * `record_skill` tool on the `usage-stats` MCP server on each activation.
 *
 * These functions are PURE: no filesystem, no globals, no I/O.
 */

/** Version marker embedded in the managed block delimiters. */
export const MANAGED_BLOCK_VERSION = 1;

const BEGIN_MARKER = `<!-- agent-usage:begin v${MANAGED_BLOCK_VERSION} -->`;
const END_MARKER = '<!-- agent-usage:end -->';

const BEGIN_PATTERN = /<!-- agent-usage:begin v(\d+) -->/;
const END_PATTERN = /<!-- agent-usage:end -->/;

/**
 * Build the managed accounting block text for a given skill id. The block is
 * self-contained: it begins with the begin marker and ends with the end
 * marker, each on its own line. The returned text always ends with a single
 * trailing newline (after the end marker line).
 */
export function accountingBlock(skillId: string): string {
  const payload = `{"skill_id":"${skillId}"}`;
  return [
    BEGIN_MARKER,
    '**Usage accounting:** Every time this skill is activated, call the',
    '`record_skill` tool from the `usage-stats` MCP server with',
    `\`${payload}\`. After any successful response,`,
    'continue with the instructions below. Do not call it when merely listing, inspecting, editing, or',
    'validating this skill. If the tool is unavailable, continue without retrying.',
    END_MARKER,
    '',
  ].join('\n');
}

/**
 * Return true when `content` contains a complete managed-block region (a
 * begin marker followed by an end marker). A lone begin marker without its
 * end is not considered a managed block.
 */
export function hasManagedBlock(content: string): boolean {
  const begin = BEGIN_PATTERN.exec(content);
  if (!begin) return false;
  const after = content.slice(begin.index + begin[0].length);
  return END_PATTERN.test(after);
}

/**
 * Split `content` into a frontmatter prefix (including both `---` delimiters
 * and the trailing newline) and the remaining body. When the file has no
 * frontmatter, the prefix is the empty string and the body is the original
 * content.
 *
 * A frontmatter block is recognized iff the first line is exactly `---` and a
 * subsequent line is exactly `---`. A later `---` (e.g. a Markdown horizontal
 * rule) is treated as body content.
 *
 * The opening delimiter may use either LF (`---\n`) or CRLF (`---\r\n`) line
 * endings — a CRLF-encoded `SKILL.md` must keep its frontmatter at the very
 * top. The detected terminator is used consistently for the returned prefix so
 * the round-trip stays lossless.
 */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  // Detect the line terminator on the opening delimiter once. LF content keeps
  // the original behavior; CRLF content (Windows-saved files) is recognized so
  // the managed block lands after the closing delimiter instead of at the top.
  const isCrlf = content.startsWith('---\r\n');
  const opener = isCrlf ? '---\r\n' : '---\n';
  if (!content.startsWith(opener)) {
    return { frontmatter: '', body: content };
  }
  const lines = content.split(isCrlf ? '\r\n' : '\n');
  // lines[0] === '---'; find the closing delimiter (an exact '---' line).
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      const closingLineIndex = index;
      const terminator = isCrlf ? '\r\n' : '\n';
      const frontmatter =
        lines.slice(0, closingLineIndex + 1).join(terminator) + terminator;
      const body = lines.slice(closingLineIndex + 1).join(terminator);
      return { frontmatter, body };
    }
  }
  return { frontmatter: '', body: content };
}

/**
 * Remove the managed block (if present) along with the single blank line the
 * injector introduced immediately after frontmatter, returning the surrounding
 * body verbatim. Removing from content without a block is a no-op.
 *
 * The block is a self-contained run of whole lines (begin marker through the
 * end marker line, whose trailing newline is the block's own terminator). Only
 * that run is removed, plus — when present — the one blank line the injector
 * pads between the closing frontmatter delimiter and the block. Body content
 * (including its own blank lines) is never touched.
 */
export function removeManagedBlock(content: string): string {
  const begin = BEGIN_PATTERN.exec(content);
  if (!begin) return content;
  const afterBegin = content.slice(begin.index + begin[0].length);
  const end = END_PATTERN.exec(afterBegin);
  if (!end) return content;

  const lines = content.split('\n');
  let beginLine = -1;
  let endLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (beginLine === -1 && BEGIN_PATTERN.test(line)) {
      beginLine = index;
    }
    if (beginLine !== -1 && END_PATTERN.test(line)) {
      endLine = index;
      break;
    }
  }
  if (beginLine === -1 || endLine === -1) return content;

  // Drop the single blank line the injector adds between the closing
  // frontmatter delimiter (`---`) and the block. We only do this when the
  // pattern is exactly `---\n\n<begin>` so a body paragraph break is never
  // mistaken for injected padding. The closing delimiter may carry a trailing
  // `\r` on CRLF-encoded files (split on `\n` leaves it attached), so accept
  // both `---` and `---\r`.
  const beforeBegin = lines[beginLine - 1];
  const beforeBeforeBegin = lines[beginLine - 2];
  if (
    beforeBegin === '' &&
    (beforeBeforeBegin === '---' || beforeBeforeBegin === '---\r')
  ) {
    beginLine -= 1;
  }

  const head = lines.slice(0, beginLine);
  const tail = lines.slice(endLine + 1);

  // Removing the block may bring two blank lines together at the seam (e.g. a
  // block that was hand-placed mid-paragraph, or padding on both sides).
  // Collapse the seam down to at most one blank line so we never leave a
  // double blank that wasn't in the original. Non-seam blank lines are
  // untouched.
  while (
    head.length > 0 &&
    tail.length > 0 &&
    head[head.length - 1] === '' &&
    tail[0] === ''
  ) {
    tail.shift();
  }

  return head.concat(tail).join('\n');
}

/**
 * Inject the managed accounting block for `skillId` into `content`. The block
 * is placed immediately after the YAML frontmatter (when present) or at the
 * very top otherwise. Idempotent: at most one block is ever present,
 * reflecting the latest `skillId`.
 */
export function injectManagedBlock(content: string, skillId: string): string {
  const stripped = removeManagedBlock(content);
  const { frontmatter, body } = splitFrontmatter(stripped);
  const block = accountingBlock(skillId);

  if (frontmatter) {
    return `${frontmatter}\n${block}${body}`;
  }
  return `${block}${body}`;
}
