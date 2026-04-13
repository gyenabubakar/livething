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
        'ack/symbols': resolve(__dirname, 'src/ack/symbols.ts'),
        heartbeat: resolve(__dirname, 'src/heartbeat/index.ts'),
        'heartbeat/symbols': resolve(__dirname, 'src/heartbeat/symbols.ts'),
        sequence: resolve(__dirname, 'src/sequence/index.ts'),
        'sequence/symbols': resolve(__dirname, 'src/sequence/symbols.ts'),
        dedup: resolve(__dirname, 'src/dedup/index.ts'),
        'dedup/symbols': resolve(__dirname, 'src/dedup/symbols.ts'),
        hibernation: resolve(__dirname, 'src/hibernation/index.ts'),
        'hibernation/symbols': resolve(__dirname, 'src/hibernation/symbols.ts'),
        errors: resolve(__dirname, 'src/errors/index.ts'),
        'errors/symbols': resolve(__dirname, 'src/errors/symbols.ts'),
        scheduled: resolve(__dirname, 'src/scheduled/index.ts'),
        'scheduled/symbols': resolve(__dirname, 'src/scheduled/symbols.ts'),
        request: resolve(__dirname, 'src/request/index.ts'),
        'request/symbols': resolve(__dirname, 'src/request/symbols.ts'),
        intercept: resolve(__dirname, 'src/intercept/index.ts'),
        'intercept/symbols': resolve(__dirname, 'src/intercept/symbols.ts'),
        channel: resolve(__dirname, 'src/channel/index.ts'),
        'channel/symbols': resolve(__dirname, 'src/channel/symbols.ts'),
        namespace: resolve(__dirname, 'src/namespace/index.ts'),
        'namespace/symbols': resolve(__dirname, 'src/namespace/symbols.ts'),
        stream: resolve(__dirname, 'src/stream/index.ts'),
        'stream/symbols': resolve(__dirname, 'src/stream/symbols.ts'),
        replay: resolve(__dirname, 'src/replay/index.ts'),
        'replay/symbols': resolve(__dirname, 'src/replay/symbols.ts'),
        'replay/custom': resolve(__dirname, 'src/replay/custom/index.ts'),
        'replay/custom/symbols': resolve(__dirname, 'src/replay/custom/symbols.ts'),
        lifecycle: resolve(__dirname, 'src/lifecycle/index.ts'),
        'lifecycle/symbols': resolve(__dirname, 'src/lifecycle/symbols.ts'),
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
