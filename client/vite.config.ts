import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [dts({ rollupTypes: true })],
  resolve: {
    alias: {
      '~': resolve(__dirname, 'src'),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        plugins: resolve(__dirname, 'src/plugins/index.ts'),
        testing: resolve(__dirname, 'src/testing.ts'),
      },
      formats: ['es'],
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
