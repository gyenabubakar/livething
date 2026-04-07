/// <reference types="vitest/config" />
import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts()],
  resolve: {
    alias: [
      { find: '~', replacement: resolve(__dirname, '../server-codegen/src') },
      { find: /^@wskit\/core$/, replacement: resolve(__dirname, '../../core/src/index.ts') },
      {
        find: /^@wskit\/server-codegen$/,
        replacement: resolve(__dirname, '../server-codegen/src/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/ack$/,
        replacement: resolve(__dirname, '../server-codegen/src/ack/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/channel$/,
        replacement: resolve(__dirname, '../server-codegen/src/channel/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/errors$/,
        replacement: resolve(__dirname, '../server-codegen/src/errors.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/errors\/errors$/,
        replacement: resolve(__dirname, '../server-codegen/src/errors/errors.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/hibernation$/,
        replacement: resolve(__dirname, '../server-codegen/src/hibernation/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/incoming$/,
        replacement: resolve(__dirname, '../server-codegen/src/incoming/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/intercept$/,
        replacement: resolve(__dirname, '../server-codegen/src/intercept/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/lifecycle$/,
        replacement: resolve(__dirname, '../server-codegen/src/lifecycle.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/namespace$/,
        replacement: resolve(__dirname, '../server-codegen/src/namespace/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/outgoing$/,
        replacement: resolve(__dirname, '../server-codegen/src/outgoing/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/passive$/,
        replacement: resolve(__dirname, '../server-codegen/src/passive/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/registry$/,
        replacement: resolve(__dirname, '../server-codegen/src/registry.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/replay$/,
        replacement: resolve(__dirname, '../server-codegen/src/replay/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/request$/,
        replacement: resolve(__dirname, '../server-codegen/src/request/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/scheduled$/,
        replacement: resolve(__dirname, '../server-codegen/src/scheduled/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/stream$/,
        replacement: resolve(__dirname, '../server-codegen/src/stream/index.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/primitive$/,
        replacement: resolve(__dirname, '../server-codegen/src/primitive.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/internal\/define-server$/,
        replacement: resolve(__dirname, '../server-codegen/src/define-server.ts'),
      },
      {
        find: /^@wskit\/server-codegen\/internal\/define-module$/,
        replacement: resolve(__dirname, '../server-codegen/src/define-module.ts'),
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
      external: [/^@wskit\/core(?:\/.*)?$/, /^@wskit\/server-codegen(?:\/.*)?$/],
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
