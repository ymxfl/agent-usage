import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/agent-usage.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  banner: {
    // The bundle ships as ESM but pulls in CJS dependencies (e.g. `yaml`)
    // whose CommonJS internals call `require('process')` / `require('buffer')`
    // for Node builtins. esbuild routes those through a generated `require`
    // shim that throws ("Dynamic require ... is not supported") when the bundle
    // is loaded as ESM, because no `require` is in scope. Exposing a real
    // `require` (via createRequire) lets the shim resolve the builtins
    // natively, so the runtime can be copied to ~/.joycode and run standalone.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __agentUsageCreateRequire } from 'node:module';",
      'const require = __agentUsageCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  sourcemap: true,
});
