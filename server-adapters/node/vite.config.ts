import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { relativizeTildeImports } from '../../scripts/vite-dts.ts';

export default defineConfig({
  plugins: [
    dts({
      exclude: ['**/*.spec.ts', '**/*.test.ts', '**/*.test-d.ts'],
      beforeWriteFile: relativizeTildeImports(resolve(__dirname, 'dist')),
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
      },
      formats: ['es'],
    },
    minify: true,
    sourcemap: true,
    rollupOptions: {
      external: [/^node:/, /^@wskit\/server(?:\/.*)?$/, /^better-sqlite3$/],
    },
  },
});
