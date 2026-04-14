import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [dts()],
  resolve: {
    alias: {
      '~': resolve(__dirname, 'src'),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        '_adapters/index': resolve(__dirname, 'src/_adapters/index.ts'),
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
        'replay/custom': resolve(__dirname, 'src/replay/custom/index.ts'),
        lifecycle: resolve(__dirname, 'src/lifecycle/index.ts'),
        infrastructure: resolve(__dirname, 'src/infrastructure/index.ts'),
        full: resolve(__dirname, 'src/full/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@wskit/core', '@wskit/shared'],
      treeshake: {
        moduleSideEffects: true,
      },
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
