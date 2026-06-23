import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect } from 'vitest';

import { describe, it } from 'vitest';

import { atomicWrite } from '../../src/core/atomic-file.js';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-usage-atomic-'));
}

async function listTempArtifacts(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((name) => name.includes('.agent-usage-'));
}

describe('atomicWrite', () => {
  it('creates a nested non-existent parent directory and writes content', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'a', 'b', 'c', 'file.txt');

    await atomicWrite(target, 'hello world');

    await expect(readFile(target, 'utf8')).resolves.toBe('hello world');
  });

  it('preserves UTF-8 content byte-for-byte', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'utf8.txt');
    const payload = 'snowman: ☃, rocket: 🚀, runes: ᚠᚢᚦ';

    await atomicWrite(target, payload);

    await expect(readFile(target, 'utf8')).resolves.toBe(payload);
  });

  it('writes raw bytes from a Uint8Array', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'binary.bin');
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254]);

    await atomicWrite(target, bytes);

    const written = await readFile(target);
    expect(Array.from(written)).toEqual(Array.from(bytes));
  });

  it('overwrites a pre-existing file atomically', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'replace.txt');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'old content');

    await atomicWrite(target, 'new content');

    await expect(readFile(target, 'utf8')).resolves.toBe('new content');
  });

  it.runIf(process.platform !== 'win32')(
    'sets the requested file mode on the final file',
    async () => {
      const root = await temporaryDirectory();
      const target = join(root, 'mode.txt');
      const previousUmask = process.umask(0o077);

      try {
        await atomicWrite(target, 'data', 0o600);
      } finally {
        process.umask(previousUmask);
      }

      expect((await stat(target)).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'replaces the previous mode when overwriting with a new one',
    async () => {
      const root = await temporaryDirectory();
      const target = join(root, 'mode-replace.txt');
      await writeFile(target, 'first', { mode: 0o600 });
      const previousUmask = process.umask(0o077);

      try {
        await atomicWrite(target, 'second', 0o644);
      } finally {
        process.umask(previousUmask);
      }

      expect((await stat(target)).mode & 0o777).toBe(0o644);
    },
  );

  it('leaves no temp artifacts behind on a successful write', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'nested', 'clean.txt');

    await atomicWrite(target, 'clean');

    expect(await listTempArtifacts(root)).toEqual([]);
  });

  it('cleans up its temp file when the rename fails and leaves the original intact', async () => {
    const root = await temporaryDirectory();
    // Make the target path itself a directory so renaming onto it fails.
    const target = join(root, 'collides');
    await mkdir(target);
    await writeFile(join(target, 'sentinel'), 'keep me');

    await expect(atomicWrite(target, 'payload')).rejects.toThrow();

    // Original directory contents preserved.
    await expect(
      readFile(join(target, 'sentinel'), 'utf8'),
    ).resolves.toBe('keep me');
    // No stray temp files littering the parent directory.
    expect(await listTempArtifacts(root)).toEqual([]);
  });

  it('does not leave temp artifacts across concurrent writes to distinct files', async () => {
    const root = await temporaryDirectory();
    const targets = Array.from({ length: 8 }, (_, index) =>
      join(root, `file-${index}.txt`),
    );

    await Promise.all(targets.map((target) => atomicWrite(target, 'x')));

    for (const target of targets) {
      await expect(readFile(target, 'utf8')).resolves.toBe('x');
    }
    expect(await listTempArtifacts(root)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'honors an explicit non-default mode for a binary payload',
    async () => {
      const root = await temporaryDirectory();
      const target = join(root, 'exec.bin');
      const previousUmask = process.umask(0o077);

      try {
        await atomicWrite(target, new Uint8Array([1, 2, 3]), 0o755);
      } finally {
        process.umask(previousUmask);
      }

      expect((await stat(target)).mode & 0o777).toBe(0o755);
    },
  );

  it('ignores a stale mode when the target already exists with looser permissions', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'loose.txt');
    await writeFile(target, 'first');
    // best-effort loosen; ignore failures on platforms that ignore chmod
    await chmod(target, 0o666).catch(() => undefined);

    await atomicWrite(target, 'second', 0o644);

    await expect(readFile(target, 'utf8')).resolves.toBe('second');
  });
});
