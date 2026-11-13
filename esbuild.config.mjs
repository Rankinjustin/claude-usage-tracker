import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

/** Lets bundles import `file?raw` as text, matching Vite/Vitest. */
const rawText = {
  name: 'raw-text',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({
      path: resolve(a.resolveDir, a.path.slice(0, -4)),
      namespace: 'raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({
      contents: `export default ${JSON.stringify(readFileSync(a.path, 'utf8'))};`,
      loader: 'js',
    }));
  },
};

/**
 * The CLI must reach its Node-version check before anything needs `node:sqlite`, but esbuild hoists
 * external imports to the top of the bundle. This shim looks the module up lazily instead.
 */
const lazySqlite = {
  name: 'lazy-sqlite',
  setup(b) {
    b.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: 'node:sqlite', namespace: 'lazy-sqlite' }));
    b.onLoad({ filter: /.*/, namespace: 'lazy-sqlite' }, () => ({
      contents: "const m = process.getBuiltinModule?.('node:sqlite') ?? {};\nexport const DatabaseSync = m.DatabaseSync;",
      loader: 'js',
    }));
  },
};

const common ={ bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'info',
  plugins: [rawText] };

await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.mjs',
  plugins: [rawText, lazySqlite] });
await build({ ...common, entryPoints: ['src/server/server.ts'], outfile: 'dist/server.mjs' });
