import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    root: './',
  },
  // SWC (not esbuild) so `emitDecoratorMetadata` survives — Nest's DI depends on it.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
