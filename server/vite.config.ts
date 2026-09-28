import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { relativizeTildeImports } from '../scripts/vite-dts.ts';

export default defineConfig({
  plugins: [
    dts({
      exclude: ['**/*.spec.ts', '**/*.test.ts', '**/*.test-d.ts'],
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
        '_adapters/index': resolve(__dirname, 'src/_adapters/index.ts'),
        errors: resolve(__dirname, 'src/errors/index.ts'),
        'client-requests': resolve(__dirname, 'src/request/client-requests.ts'),
        'server-requests': resolve(__dirname, 'src/request/server-requests.ts'),
        scheduled: resolve(__dirname, 'src/scheduled/capability.ts'),
        dedup: resolve(__dirname, 'src/dedup/capability.ts'),
        sequence: resolve(__dirname, 'src/sequence/capability.ts'),
        keepalive: resolve(__dirname, 'src/keepalive/capability.ts'),
        'rate-limit': resolve(__dirname, 'src/rate-limit/capability.ts'),
        replay: resolve(__dirname, 'src/replay/capability.ts'),
        inbox: resolve(__dirname, 'src/inbox/capability.ts'),
        'last-seen': resolve(__dirname, 'src/last-seen/capability.ts'),
        streams: resolve(__dirname, 'src/streams.ts'),
        // Each stream capability is its own entry so a consumer importing only
        // one of them from `@livething/server/streams` does not pull the engines of
        // the others — the barrel re-exports these separable chunks.
        'stream/capability': resolve(__dirname, 'src/stream/capability.ts'),
        'stream-resumable/capability': resolve(__dirname, 'src/stream-resumable/capability.ts'),
        'stream-recorded/capability': resolve(__dirname, 'src/stream-recorded/capability.ts'),
        channels: resolve(__dirname, 'src/channel/index.ts'),
        tags: resolve(__dirname, 'src/tags/capability.ts'),
        intercepts: resolve(__dirname, 'src/intercept/index.ts'),
        plugins: resolve(__dirname, 'src/_define/plugins.ts'),
      },
      formats: ['es'],
    },
    minify: true,
    sourcemap: true,
    rollupOptions: {
      // @livething/core is now a real published peer; consumers install it
      // alongside @livething/server. Keep it external so the server bundle does
      // not duplicate core's runtime code.
      external: [/^@livething\/core(?:\/.*)?$/, /^@standard-schema\/.+$/],
    },
  },
});
