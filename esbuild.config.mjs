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

const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'info',
  plugins: [rawText] };

await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.mjs' });
await build({ ...common, entryPoints: ['src/server/server.ts'], outfile: 'dist/server.mjs' });
