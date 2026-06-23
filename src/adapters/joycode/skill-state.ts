/**
 * Versioned manifest tracking the instrumentation state of JoyCode Skills.
 *
 * The reconciler writes one of these to `stateFile` after every `sync()` so
 * external tooling can detect which Skills have been instrumented, with which
 * `skillId`, and verify byte-for-byte integrity via `beforeHash`/`afterHash`.
 */

/** State for a single instrumented Skill, keyed in the manifest by canonical path. */
export interface InstrumentedSkillState {
  /** Absolute, symlink-resolved path to the `SKILL.md` on disk. */
  canonicalPath: string;
  /** Stable id derived from `(agent, scope, canonicalPath)`. */
  skillId: string;
  /** Scope the Skill was discovered under. */
  scope: 'user' | 'project';
  /** Managed-block version present in the file. */
  injectionVersion: 1;
  /** SHA-256 of the file bytes immediately before injection. */
  beforeHash: string;
  /** SHA-256 of the file bytes immediately after injection. */
  afterHash: string;
  /** ISO timestamp of the last successful `sync()` that touched this skill. */
  lastSeenAt: string;
}

/** On-disk manifest shape, versioned for forward migrations. */
export interface JoyCodeSkillManifest {
  version: 1;
  /** Canonical path → state. */
  skills: Record<string, InstrumentedSkillState>;
}

/** Fresh empty manifest. */
export const emptyJoyCodeManifest = (): JoyCodeSkillManifest => ({
  version: 1,
  skills: {},
});
