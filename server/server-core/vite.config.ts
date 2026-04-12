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
      '@wskit/server': resolve(__dirname, './src/index.ts'),
      '@wskit/server/adapters': resolve(__dirname, './src/adapters.ts'),
      '@wskit/server/modules': resolve(__dirname, './src/modules/index.ts'),
      '@wskit/server/replay/custom': resolve(__dirname, './src/replay/custom.ts'),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        adapters: resolve(__dirname, 'src/adapters.ts'),
        modules: resolve(__dirname, 'src/modules/index.ts'),
        ack: resolve(__dirname, 'src/ack/index.ts'),
        heartbeat: resolve(__dirname, 'src/heartbeat/index.ts'),
        sequence: resolve(__dirname, 'src/sequence/index.ts'),
        dedup: resolve(__dirname, 'src/dedup/index.ts'),
        hibernation: resolve(__dirname, 'src/hibernation/index.ts'),
        errors: resolve(__dirname, 'src/errors/index.ts'),
        scheduled: resolve(__dirname, 'src/scheduled/index.ts'),
        request: resolve(__dirname, 'src/request/index.ts'),
        intercept: resolve(__dirname, 'src/intercept/index.ts'),
        channel: resolve(__dirname, 'src/channel/index.ts'),
        namespace: resolve(__dirname, 'src/namespace/index.ts'),
        stream: resolve(__dirname, 'src/stream/index.ts'),
        replay: resolve(__dirname, 'src/replay/index.ts'),
        'replay/custom': resolve(__dirname, 'src/replay/custom.ts'),
        lifecycle: resolve(__dirname, 'src/lifecycle.ts'),
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
