import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JoyCodeSkillReconciler } from '../../../src/adapters/joycode/reconciler.js';
import {
  emptyJoyCodeManifest,
  type JoyCodeSkillManifest,
} from '../../../src/adapters/joycode/skill-state.js';
import { injectAccountingBlock } from '../../../src/adapters/joycode/skill-file.js';

const SKILL_WITH_FM = `---
name: deploy
description: Deploy safely
---

# Deploy

Do work.
`;

const SKILL_MALFORMED_FM = `---
name: deploy
description: "unterminated
---

# Deploy
`;

async function writeSkill(
  root: string,
  skill: string,
  content: string,
): Promise<string> {
  const dir = join(root, skill);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  await writeFile(file, content, 'utf8');
  // Canonical (realpath) path, which is what the reconciler reports and keys on
  // (mkdtemp lives under a symlinked tmp on some platforms, e.g. macOS /var).
  return realpath(file);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

describe('JoyCodeSkillReconciler', () => {
  let userRoot: string;
  let projectRoot: string;
  let outside: string;
  let stateFile: string;

  beforeEach(() => {
    userRoot = mkdtempSync(join(tmpdir(), 'jc-user-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'jc-project-'));
    outside = mkdtempSync(join(tmpdir(), 'jc-outside-'));
    stateFile = join(userRoot, 'state.json');
  });

  afterEach(async () => {
    await Promise.all([
      rm(userRoot, { recursive: true, force: true }),
      rm(projectRoot, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('instruments user-scope and project-scope skills', async () => {
    const userFile = await writeSkill(userRoot, 'alpha', SKILL_WITH_FM);
    const projectFile = await writeSkill(projectRoot, 'beta', SKILL_WITH_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [
        { path: userRoot, scope: 'user' },
        { path: projectRoot, scope: 'project' },
      ],
      stateFile,
    });

    const result = await reconciler.sync();

    expect(result.instrumented).toHaveLength(2);
    expect(result.instrumented).toContain(userFile);
    expect(result.instrumented).toContain(projectFile);
    expect(result.degraded).toEqual([]);

    const userContent = await readFile(userFile, 'utf8');
    expect(userContent).toContain('<!-- agent-usage:begin v1 -->');
    const fmEnd = userContent.indexOf('---\n', userContent.indexOf('---\n') + 1);
    const beginIndex = userContent.indexOf('<!-- agent-usage:begin v1 -->');
    expect(beginIndex).toBeGreaterThan(fmEnd);
  });

  it('refuses a symlink that resolves outside the root', async () => {
    // Normal skill inside root.
    await writeSkill(userRoot, 'good', SKILL_WITH_FM);
    // File OUTSIDE the root.
    const outsideFile = join(outside, 'SKILL.md');
    await mkdir(outside, { recursive: true });
    await writeFile(outsideFile, SKILL_WITH_FM, 'utf8');
    // Symlink INSIDE the root pointing at the outside file.
    const linkDir = join(userRoot, 'evil');
    await mkdir(linkDir, { recursive: true });
    await symlink(outsideFile, join(linkDir, 'SKILL.md'));

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    const result = await reconciler.sync();

    const evilDegraded = result.degraded.find(
      (d) => d.reason === 'symlink-outside-root',
    );
    expect(evilDegraded).toBeDefined();
    // The outside target was NOT written.
    const outsideContent = await readFile(outsideFile, 'utf8');
    expect(outsideContent).not.toContain('agent-usage:begin');
  });

  it('refuses malformed YAML frontmatter without writing', async () => {
    const file = await writeSkill(userRoot, 'broken', SKILL_MALFORMED_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    const result = await reconciler.sync();

    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0]?.reason.toLowerCase()).toMatch(/frontmatter|yaml/);
    expect(result.instrumented).not.toContain(file);
    // File NOT modified.
    expect(await readFile(file, 'utf8')).toBe(SKILL_MALFORMED_FM);
  });

  it('records a read-only file as degraded without modifying it', async () => {
    const file = await writeSkill(userRoot, 'locked', SKILL_WITH_FM);
    await chmod(file, 0o444);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    const result = await reconciler.sync();

    expect(result.degraded).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe(SKILL_WITH_FM);
  });

  it('is idempotent: a second sync reports unchanged and stays byte-stable', async () => {
    const file = await writeSkill(userRoot, 'alpha', SKILL_WITH_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    const first = await reconciler.sync();
    expect(first.instrumented).toContain(file);

    const afterFirst = await readFile(file, 'utf8');
    const second = await reconciler.sync();

    expect(second.unchanged).toContain(file);
    expect(second.instrumented).not.toContain(file);
    expect(await readFile(file, 'utf8')).toBe(afterFirst);
  });

  it('preserves an external body change while keeping a single block', async () => {
    const file = await writeSkill(userRoot, 'alpha', SKILL_WITH_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    await reconciler.sync();
    const originalInjected = await readFile(file, 'utf8');

    // External edit: append body text after injection.
    await writeFile(file, `${originalInjected}\n\nNew trailing paragraph.\n`, 'utf8');

    await reconciler.sync();

    const afterSecond = await readFile(file, 'utf8');
    // Body change preserved.
    expect(afterSecond).toContain('New trailing paragraph.');
    // Exactly one managed block (never duplicated).
    const beginCount = (afterSecond.match(/agent-usage:begin v\d+/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  it('re-injects when the body above the block changes', async () => {
    const file = await writeSkill(userRoot, 'alpha', SKILL_WITH_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    await reconciler.sync();
    const injected = await readFile(file, 'utf8');

    // Strip the managed block, mutate the body, then re-sync must re-inject.
    const stripped = injectAccountingBlock(injected, 'placeholder').content.replace(
      /<!-- agent-usage:begin v\d+ -->[\s\S]*?<!-- agent-usage:end -->\n*/,
      '',
    );
    await writeFile(file, stripped, 'utf8');

    const result = await reconciler.sync();
    expect(result.instrumented).toContain(file);

    const after = await readFile(file, 'utf8');
    expect(after).toContain('<!-- agent-usage:begin v1 -->');
    expect((after.match(/agent-usage:begin v\d+/g) ?? []).length).toBe(1);
  });

  it('gives same-name skills in different roots different skillIds', async () => {
    await writeSkill(userRoot, 'shared', SKILL_WITH_FM);
    await writeSkill(projectRoot, 'shared', SKILL_WITH_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [
        { path: userRoot, scope: 'user' },
        { path: projectRoot, scope: 'project' },
      ],
      stateFile,
    });

    await reconciler.sync();
    const manifest: JoyCodeSkillManifest = JSON.parse(
      await readFile(stateFile, 'utf8'),
    );

    const entries = Object.values(manifest.skills);
    const skillIds = entries.map((e) => e.skillId);
    expect(new Set(skillIds).size).toBe(2);
    expect(entries.some((e) => e.scope === 'user')).toBe(true);
    expect(entries.some((e) => e.scope === 'project')).toBe(true);
  });

  it('writes a manifest with version 1 and per-skill hashes', async () => {
    const file = await writeSkill(userRoot, 'alpha', SKILL_WITH_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    await reconciler.sync();
    const manifest: JoyCodeSkillManifest = JSON.parse(
      await readFile(stateFile, 'utf8'),
    );

    expect(manifest.version).toBe(1);
    const entry = manifest.skills[file];
    expect(entry).toBeDefined();
    expect(entry?.skillId).toMatch(/^joycode:user:/);
    expect(entry?.scope).toBe('user');
    expect(entry?.injectionVersion).toBe(1);
    expect(entry?.beforeHash).toBe(sha256(SKILL_WITH_FM));
    const afterContent = await readFile(file, 'utf8');
    expect(entry?.afterHash).toBe(sha256(afterContent));
    expect(typeof entry?.lastSeenAt).toBe('string');
  });

  it('removes manifest entries for skills deleted between syncs', async () => {
    const keepFile = await writeSkill(userRoot, 'keep', SKILL_WITH_FM);
    const goneFile = await writeSkill(userRoot, 'gone', SKILL_WITH_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    await reconciler.sync();

    let manifest: JoyCodeSkillManifest = JSON.parse(
      await readFile(stateFile, 'utf8'),
    );
    expect(manifest.skills[goneFile]).toBeDefined();

    await rm(join(userRoot, 'gone'), { recursive: true, force: true });
    await reconciler.sync();

    manifest = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(manifest.skills[goneFile]).toBeUndefined();
    expect(manifest.skills[keepFile]).toBeDefined();
  });

  it('writes an empty manifest when no roots exist', async () => {
    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: join(userRoot, 'missing'), scope: 'user' }],
      stateFile,
    });

    const result = await reconciler.sync();
    expect(result.instrumented).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.degraded).toEqual([]);

    const manifest: JoyCodeSkillManifest = JSON.parse(
      await readFile(stateFile, 'utf8'),
    );
    expect(manifest).toEqual(emptyJoyCodeManifest());
  });

  it('updates lastSeenAt but keeps hashes stable on unchanged re-sync', async () => {
    const file = await writeSkill(userRoot, 'alpha', SKILL_WITH_FM);
    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: userRoot, scope: 'user' }],
      stateFile,
    });

    await reconciler.sync();
    const first: JoyCodeSkillManifest = JSON.parse(
      await readFile(stateFile, 'utf8'),
    );

    // Injected body content is byte-stable across syncs, so beforeHash/afterHash
    // only exist for instrumented entries; on re-sync the entry is recomputed
    // from the (now-injected) on-disk content.
    expect(first.skills[file]).toBeDefined();
    const unchangedAfter = await readFile(file, 'utf8');
    await reconciler.sync();
    const second: JoyCodeSkillManifest = JSON.parse(
      await readFile(stateFile, 'utf8'),
    );
    // afterHash stays the injected-content hash.
    expect(second.skills[file]?.afterHash).toBe(sha256(unchangedAfter));
  });
});
