import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsc builds to ES2024; vite's bundled esbuild doesn't recognize that literal,
  // so pin the transform target here to keep test output warning-free.
  esbuild: { target: 'es2022' },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
