import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/agent-usage.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  banner: {
    js: '#!/usr/bin/env node',
  },
  sourcemap: true,
});
