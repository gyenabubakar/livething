/// <reference types="vitest/config" />
import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts({ rollupTypes: true })],
  resolve: {
    alias: {
      '~': resolve(__dirname, 'src'),
      '@wskit/core': resolve(__dirname, '../../core/src/index.ts'),
      '@wskit/shared': resolve(__dirname, '../../shared/src/index.ts'),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        errors: resolve(__dirname, 'src/errors.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@wskit/core', '@wskit/shared'],
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
