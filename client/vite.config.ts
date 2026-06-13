import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';
import { relativizeTildeImports } from '../scripts/vite-dts.ts';

export default defineConfig({
  // Per-file declarations (not rollupTypes): api-extractor only rolls a single
  // entry, leaving the other subpaths' .d.ts empty. Emitting per file gives every
  // subpath (errors, environment, platform, testing) real types. `rootDir: src` in
  // tsconfig lands them at dist root, mirroring the JS entries.
  plugins: [
    dts({
      exclude: [
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/*.test-d.ts',
        '**/*.bench.ts',
        'src/test-helpers.ts',
      ],
      beforeWriteFile: relativizeTildeImports(resolve(__dirname, 'dist')),
    }),
  ],
  resolve: {
    alias: {
      '~': resolve(__dirname, 'src'),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        errors: resolve(__dirname, 'src/errors.ts'),
        environment: resolve(__dirname, 'src/environment.ts'),
        platform: resolve(__dirname, 'src/platform.ts'),
        testing: resolve(__dirname, 'src/testing.ts'),
      },
      formats: ['es'],
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
