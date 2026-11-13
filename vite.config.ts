import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/ui',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/ui', emptyOutDir: true },
  test: { root: '.', environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
});
