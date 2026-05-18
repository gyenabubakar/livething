import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts({ exclude: ['**/*.spec.ts', '**/*.test.ts', '**/*.test-d.ts'] })],
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
      },
      formats: ['es'],
    },
    rollupOptions: {
      // @wskit/core is now a real published peer; consumers install it
      // alongside @wskit/server. Keep it external so the server bundle does
      // not duplicate core's runtime code.
      external: [/^@wskit\/core(?:\/.*)?$/, /^@standard-schema\/.+$/],
    },
  },
});
