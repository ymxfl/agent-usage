import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JoyCodeSkillReconciler } from '../../../src/adapters/joycode/reconciler.js';
import type { JoyCodeSkillManifest } from '../../../src/adapters/joycode/skill-state.js';

const SKILL_WITH_FM = `---
name: deploy
description: Deploy safely
---

# Deploy

Do work.
`;

/** Per-test timeout for the timing-sensitive chokidar tests. */
const WATCH_TEST_TIMEOUT = 15000;

function writeSkill(root: string, skill: string, content: string): string {
  const dir = join(root, skill);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, content, 'utf8');
  // mkdtemp often lives under a symlinked tmp (e.g. macOS /var); the reconciler
  // keys state on the canonical realpath, so the test must compare against it.
  return realpathSync(file);
}

/** Polls until predicate returns true, with a generous timeout for chokidar FS events. */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function readManifest(stateFile: string): Promise<JoyCodeSkillManifest> {
  return readFile(stateFile, 'utf8').then((text) => JSON.parse(text));
}

describe('JoyCodeSkillReconciler.watch()', () => {
  let root: string;
  let stateFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jc-watch-'));
    stateFile = join(root, 'state.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('instruments pre-existing skills via the initial sync()', async () => {
    const existing = writeSkill(root, 'alpha', SKILL_WITH_FM);

    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: root, scope: 'user' }],
      stateFile,
    });

    const handle = await reconciler.watch();
    try {
      expect(await readFile(existing, 'utf8')).toContain('agent-usage:begin v2');
      const manifest = await readManifest(stateFile);
      expect(manifest.skills[existing]).toBeDefined();
    } finally {
      await handle.close();
    }
  });

  it(
    'instruments a skill created during the watched session',
    async () => {
      const reconciler = new JoyCodeSkillReconciler({
        roots: [{ path: root, scope: 'user' }],
        stateFile,
      });

      const handle = await reconciler.watch();
      try {
        // Give the FS-event backend a beat to fully arm after the ready signal;
        // fsevents on macOS can drop creates that race with watch setup.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const created = writeSkill(root, 'beta', SKILL_WITH_FM);

        // Allow time for chokidar awaitWriteFinish (>=150ms) + the 200ms debounce.
        await waitFor(
          async () =>
            (await readFile(created, 'utf8')).includes('agent-usage:begin v2'),
        );

        const manifest = await readManifest(stateFile);
        expect(manifest.skills[created]).toBeDefined();
      } finally {
        await handle.close();
      }
    },
    WATCH_TEST_TIMEOUT,
  );

  it(
    'coalesces rapid changes into a single sync (debounce)',
    async () => {
      const reconciler = new JoyCodeSkillReconciler({
        roots: [{ path: root, scope: 'user' }],
        stateFile,
      });

      const syncSpy = spyOnSync(reconciler);
      const handle = await reconciler.watch();
      syncSpy.reset(); // ignore the initial sync call

      try {
        // Let the FS-event backend fully arm before creating files.
        await new Promise((resolve) => setTimeout(resolve, 200));
        // Create several skills in quick succession within the debounce window.
        writeSkill(root, 'a', SKILL_WITH_FM);
        writeSkill(root, 'b', SKILL_WITH_FM);
        writeSkill(root, 'c', SKILL_WITH_FM);

        await waitFor(async () => {
          const manifest = await readManifest(stateFile);
          return Object.keys(manifest.skills).length === 3;
        });

        // Wait beyond the debounce to let any pending timers settle, then sample.
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Debounce should keep the number of sync calls small (well below one-per-file).
        expect(syncSpy.count()).toBeLessThan(4);
      } finally {
        await handle.close();
      }
    },
    WATCH_TEST_TIMEOUT,
  );

  it('stops watching after close(): a later new skill is not instrumented', async () => {
    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: root, scope: 'user' }],
      stateFile,
    });

    const handle = await reconciler.watch();
    await handle.close();

    const created = writeSkill(root, 'after-close', SKILL_WITH_FM);

    // Give the watcher enough time that it WOULD have fired if still active.
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(await readFile(created, 'utf8')).not.toContain('agent-usage:begin v2');
  });

  it('close() clears timers and closes the watcher (no leaked FS handles)', async () => {
    const reconciler = new JoyCodeSkillReconciler({
      roots: [{ path: root, scope: 'user' }],
      stateFile,
    });

    const handle = await reconciler.watch();
    // Trigger a debounced sync so a timer is pending when we close.
    writeSkill(root, 'ephemeral', SKILL_WITH_FM);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Must resolve (does not hang) and exits cleanly afterward.
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

/** Minimal spy that counts calls to the reconciler's sync() without vitest internals. */
function spyOnSync(reconciler: JoyCodeSkillReconciler): {
  reset(): void;
  count(): number;
} {
  const original = reconciler.sync.bind(reconciler);
  let calls = 0;
  reconciler.sync = async () => {
    calls += 1;
    return original();
  };
  return {
    reset() {
      calls = 0;
    },
    count() {
      return calls;
    },
  };
}
