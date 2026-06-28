import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, glob, readFile, realpath, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { watch } from 'chokidar';
import YAML from 'yaml';

import { atomicWrite } from '../../core/atomic-file.js';
import { stableSkillId } from '../../core/identity.js';
import {
  injectAccountingBlock,
  MANAGED_BLOCK_VERSION,
} from './skill-file.js';
import {
  emptyJoyCodeManifest,
  type InstrumentedSkillState,
  type JoyCodeSkillManifest,
} from './skill-state.js';

/** A JoyCode Skill root and the scope its discovered Skills belong to. */
export interface JoyCodeSkillRoot {
  path: string;
  scope: 'user' | 'project';
}

/** Constructor options. */
export interface JoyCodeSkillReconcilerOptions {
  roots: JoyCodeSkillRoot[];
  /** Where the manifest is atomically written after each `sync()`. */
  stateFile: string;
}

/** Outcome of a single `sync()` pass. All entries are canonical paths. */
export interface JoyCodeReconcileResult {
  /** Skills that were (re-)instrumented this pass. */
  instrumented: string[];
  /** Skills already up to date (no write performed). */
  unchanged: string[];
  /** Skills skipped due to safety/validation/error conditions. */
  degraded: Array<{ path: string; reason: string }>;
}

const sha256 = (data: string): string =>
  createHash('sha256').update(data, 'utf8').digest('hex');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Coalesce rapid FS events into a single `sync()` pass. */
const WATCH_DEBOUNCE_MS = 200;
/** Wait for writes to settle before firing a chokidar event. */
const WATCH_STABILITY_THRESHOLD_MS = 150;
const WATCH_STABILITY_POLL_MS = 25;

/**
 * Reconciles JoyCode Skills on disk: discovers `SKILL.md` files under each root,
 * safely injects the managed accounting block, refuses anything that escapes the
 * root or fails validation, and records the resulting state in a versioned
 * manifest.
 *
 * Safe by construction: every per-file operation is isolated so a single bad
 * file (read-only, malformed frontmatter, symlink escape, write failure) is
 * recorded as `degraded` and skipped rather than crashing the whole sync. No
 * bytes are ever written outside a root.
 */
export class JoyCodeSkillReconciler {
  private readonly roots: readonly JoyCodeSkillRoot[];
  private readonly stateFile: string;

  constructor(options: JoyCodeSkillReconcilerOptions) {
    this.roots = options.roots;
    this.stateFile = options.stateFile;
  }

  async sync(): Promise<JoyCodeReconcileResult> {
    const instrumented: string[] = [];
    const unchanged: string[] = [];
    const degraded: Array<{ path: string; reason: string }> = [];
    const skills: Record<string, InstrumentedSkillState> = {};

    for (const root of this.roots) {
      let realRoot: string;
      try {
        realRoot = await realpath(root.path);
      } catch {
        // Missing root: skip silently rather than failing the whole sync.
        continue;
      }

      const seenCanonicals = new Set<string>();

      // `glob` yields non-realpath'd paths. Resolve each to detect escapes.
      for await (const entry of glob('*/SKILL.md', { cwd: root.path })) {
        const discovered = `${root.path}/${entry}`;

        let canonical: string;
        try {
          canonical = await realpath(discovered);
        } catch (error) {
          degraded.push({ path: discovered, reason: String(error) });
          continue;
        }

        // Containment: the resolved path must live inside the resolved root.
        const rel = relative(realRoot, canonical);
        if (rel.startsWith('..') || rel === '..') {
          degraded.push({ path: canonical, reason: 'symlink-outside-root' });
          continue;
        }

        // Dedupe across roots that may share realpath space.
        if (seenCanonicals.has(canonical)) continue;
        seenCanonicals.add(canonical);

        let original: string;
        try {
          original = await readFile(canonical, 'utf8');
        } catch (error) {
          degraded.push({ path: canonical, reason: String(error) });
          continue;
        }

        const fmMatch = original.match(FRONTMATTER_RE);
        if (fmMatch) {
          try {
            YAML.parse(fmMatch[1] ?? '');
          } catch (error) {
            degraded.push({
              path: canonical,
              reason: `malformed frontmatter: ${String(error)}`,
            });
            continue;
          }
        }

        const skillId = stableSkillId('joycode', root.scope, canonical);
        const skillName = String(entry).split('/')[0];
        const { content: next, changed } = injectAccountingBlock(
          original,
          skillId,
          skillName,
        );

        if (changed) {
          // Refuse read-only targets up front: atomicWrite replaces via rename,
          // which bypasses the target file's mode, so a mode check on the file
          // is the only way to honor a read-only Skill safely.
          try {
            await access(canonical, constants.W_OK);
          } catch (error) {
            degraded.push({ path: canonical, reason: String(error) });
            continue;
          }
          let mode: number | undefined;
          try {
            mode = (await stat(canonical)).mode & 0o777;
          } catch {
            mode = undefined;
          }
          try {
            await atomicWrite(
              canonical,
              next,
              mode === undefined ? 0o644 : mode,
            );
            instrumented.push(canonical);
          } catch (error) {
            degraded.push({ path: canonical, reason: String(error) });
            continue;
          }
        } else {
          unchanged.push(canonical);
        }

        skills[canonical] = {
          canonicalPath: canonical,
          skillId,
          scope: root.scope,
          injectionVersion: MANAGED_BLOCK_VERSION,
          beforeHash: sha256(original),
          afterHash: sha256(next),
          lastSeenAt: new Date().toISOString(),
        };
      }
    }

    const manifest: JoyCodeSkillManifest = {
      version: 1,
      skills,
    };
    await atomicWrite(this.stateFile, JSON.stringify(manifest, null, 2) + '\n');

    return { instrumented, unchanged, degraded };
  }

  /**
   * Watch every root for `SKILL.md` changes and re-run a debounced `sync()`,
   * so Skills created during a session are instrumented incrementally. The
   * returned handle clears the pending timer and closes the chokidar watcher,
   * leaving no open FS handles behind.
   *
   * We watch the root directories themselves (rather than a glob matching
   * `SKILL.md` under each skill directory) because chokidar glob patterns
   * miss the creation of an intermediate skill
   * directory that did not exist when watching started. Each event is filtered
   * to `SKILL.md` paths before scheduling a reconciled pass.
   */
  async watch(): Promise<{ close(): Promise<void> }> {
    // Initial pass: instrument anything that already exists.
    await this.sync();

    let timer: NodeJS.Timeout | undefined;
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void this.sync();
      }, WATCH_DEBOUNCE_MS);
    };

    const isSkillFile = (path: string): boolean => path.endsWith('SKILL.md');
    const watcher = watch(this.roots.map((root) => root.path), {
      // `SKILL.md` lives exactly one level under a root: `<root>/<skill>/SKILL.md`.
      depth: 2,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: WATCH_STABILITY_THRESHOLD_MS,
        pollInterval: WATCH_STABILITY_POLL_MS,
      },
    });
    watcher
      .on('add', (path) => {
        if (isSkillFile(path)) schedule();
      })
      .on('change', (path) => {
        if (isSkillFile(path)) schedule();
      })
      .on('unlink', (path) => {
        if (isSkillFile(path)) schedule();
      });

    // Wait for the FS backend to finish its initial scan before returning, so
    // files created immediately after `watch()` resolves are reliably observed.
    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });

    return {
      async close(): Promise<void> {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        await watcher.close();
      },
    };
  }
}

export { emptyJoyCodeManifest };
