import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts({ exclude: ['**/*.spec.ts', '**/*.test.ts', '**/*.test-d.ts'] })],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^cloudflare:workers$/, /^@wskit\/server(?:\/.*)?$/],
    },
  },
});
