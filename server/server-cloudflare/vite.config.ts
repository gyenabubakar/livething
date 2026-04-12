/// <reference types="vitest/config" />
import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts()],
  resolve: {
    alias: [
      {
        find: /^cloudflare:workers$/,
        replacement: resolve(__dirname, 'src/cloudflare-workers.mock.ts'),
      },
      { find: '~', replacement: resolve(__dirname, '../server-codegen/src') },
      { find: /^@wskit\/core$/, replacement: resolve(__dirname, '../../core/src/index.ts') },
      {
        find: /^@wskit\/server-codegen$/,
        replacement: resolve(__dirname, '../server-codegen/src/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/adapters$/,
        replacement: resolve(__dirname, '../server-codegen/src/adapters.ts'),
      },
    ],
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        /^cloudflare:workers$/,
        /^@wskit\/core(?:\/.*)?$/,
        /^@wskit\/server-codegen(?:\/.*)?$/,
      ],
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
