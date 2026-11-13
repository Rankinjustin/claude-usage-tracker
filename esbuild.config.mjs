import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'info' };

await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.mjs' });
await build({ ...common, entryPoints: ['src/server/server.ts'], outfile: 'dist/server.mjs' });
