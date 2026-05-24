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
    minify: true,
    sourcemap: true,
    rollupOptions: {
      // `node:*` builtins are provided by the Workers runtime (nodejs_compat);
      // keep them external so the bundler never stubs them out.
      external: [/^cloudflare:workers$/, /^node:/, /^@wskit\/server(?:\/.*)?$/],
    },
  },
});
