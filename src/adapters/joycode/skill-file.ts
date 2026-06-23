/**
 * Pure helpers for injecting an idempotent "managed accounting block" into a
 * JoyCode Skill's `SKILL.md`. The block instructs the model to call the
 * `record_skill` tool on the `usage-stats` MCP server once per session.
 *
 * These functions are PURE: no filesystem, no globals, no I/O. The contract
 * mirrors the Claude adapter's managed block but returns a `{ content, changed }`
 * tuple and is version-aware: a stale `v0` block is replaced (not duplicated)
 * with the current `v1` block.
 */

/** Current managed-block version. */
export const MANAGED_BLOCK_VERSION = 1;

const BEGIN = `<!-- agent-usage:begin v${MANAGED_BLOCK_VERSION} -->`;
const END = '<!-- agent-usage:end -->';

/** Matches a managed-block begin marker of ANY version (for upgrades/removal). */
const BEGIN_ANY = /<!-- agent-usage:begin v\d+ -->/;
const END_ANY = /<!-- agent-usage:end -->/;

const BOM = '﻿';

/**
 * Build the managed accounting block text for a given skill id, joined with the
 * supplied line terminator. The block always ends with a trailing empty line so
 * the body that follows is cleanly separated.
 */
function block(skillId: string, nl: string): string {
  return [
    BEGIN,
    '**Usage accounting:** When this skill is first activated in the current agent session, call the `record_skill` tool from the `usage-stats` MCP server exactly once with',
    `\`{"skill_id":"${skillId}"}\`. After any successful response, continue with the instructions below and do not call the accounting tool again in this session.`,
    'Do not call it when merely listing, inspecting, editing, or validating this Skill. If the tool is unavailable, continue without retrying.',
    END,
    '',
  ].join(nl);
}

/**
 * Remove the managed block (any version) along with the single blank line the
 * injector pads between the closing frontmatter delimiter and the block,
 * returning the surrounding content verbatim. Removing from content without a
 * block is a no-op. Throws when a begin marker has no matching end marker.
 *
 * Operates on whole lines so CRLF content round-trips losslessly (the trailing
 * `\r` stays attached to each line).
 */
export function removeAccountingBlock(
  content: string,
): { content: string; changed: boolean } {
  // A leading UTF-8 BOM gets glued to the begin-marker line when the file has
  // no frontmatter (the block lands on line 0). Splitting the whole content on
  // `\n` and deleting that line would drop the BOM too. Strip it first, do the
  // whole-line removal, then re-prepend it so removal is BOM-aware and the
  // BOM survives the round-trip.
  const bom = content.startsWith(BOM) ? BOM : '';
  const body = bom ? content.slice(bom.length) : content;

  const lines = body.split('\n');
  let beginLine = -1;
  let endLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (beginLine === -1 && BEGIN_ANY.test(line)) {
      beginLine = index;
    }
    if (beginLine !== -1 && END_ANY.test(line)) {
      endLine = index;
      break;
    }
  }
  if (beginLine === -1) return { content, changed: false };
  if (endLine === -1) throw new Error('Malformed agent-usage block');

  // The injector pads a single blank line between the closing frontmatter
  // delimiter (`---`, possibly with a trailing `\r` on CRLF files) and the
  // block. Drop it so removal is lossless. Only do this for the exact injected
  // pattern so a body paragraph break is never mistaken for injected padding.
  if (
    beginLine > 0 &&
    lines[beginLine - 1] === '' &&
    (lines[beginLine - 2] === '---' || lines[beginLine - 2] === '---\r')
  ) {
    beginLine -= 1;
  }

  const head = lines.slice(0, beginLine);
  const tail = lines.slice(endLine + 1);
  return { content: bom + head.concat(tail).join('\n'), changed: true };
}

/**
 * Inject the managed accounting block for `skillId` into `content`. The block is
 * placed immediately after the YAML frontmatter (when present) or at the very
 * top otherwise. Idempotent: at most one block is ever present, reflecting the
 * latest `skillId`, and re-injecting identical content is a no-op.
 */
export function injectAccountingBlock(
  content: string,
  skillId: string,
): { content: string; changed: boolean } {
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  const clean = removeAccountingBlock(content).content;
  const bom = clean.startsWith(BOM) ? BOM : '';
  const body = clean.slice(bom.length);
  const match = body.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const frontmatter = match?.[0] ?? '';
  const rest = body.slice(frontmatter.length);
  const next = `${bom}${frontmatter}${block(skillId, nl)}${rest}`;
  return { content: next, changed: next !== content };
}
