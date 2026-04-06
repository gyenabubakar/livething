/// <reference types="vitest/config" />
import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts()],
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
        ack: resolve(__dirname, 'src/ack/index.ts'),
        channel: resolve(__dirname, 'src/channel/index.ts'),
        dedup: resolve(__dirname, 'src/dedup/index.ts'),
        heartbeat: resolve(__dirname, 'src/heartbeat/index.ts'),
        namespace: resolve(__dirname, 'src/namespace/index.ts'),
        passive: resolve(__dirname, 'src/passive/index.ts'),
        replay: resolve(__dirname, 'src/replay/index.ts'),
        request: resolve(__dirname, 'src/request/index.ts'),
        sequence: resolve(__dirname, 'src/sequence/index.ts'),
        stream: resolve(__dirname, 'src/stream/index.ts'),
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
