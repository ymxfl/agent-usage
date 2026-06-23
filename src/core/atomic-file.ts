import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Atomically write `content` to `file`.
 *
 * The bytes are first written to a sibling temporary file, then `chmod`-ed to
 * `mode`, then `rename`-d onto the target (atomic on POSIX). If any step
 * fails, the temporary file is removed (best-effort) so no stray artifacts
 * remain. Missing parent directories are created.
 *
 * @param file Absolute destination path.
 * @param content String or raw bytes to write.
 * @param mode POSIX permission bits to set on the final file (default 0o644).
 */
export async function atomicWrite(
  file: string,
  content: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });

  const temporary = `${directory}/.agent-usage-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
