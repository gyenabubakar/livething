/// <reference types="vitest/config" />
import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts({ rollupTypes: true })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        plugins: resolve(__dirname, 'src/plugins/index.ts'),
      },
      formats: ['es'],
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
