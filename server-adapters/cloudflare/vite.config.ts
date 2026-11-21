import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { relativizeTildeImports } from '../../scripts/vite-dts.ts';

export default defineConfig({
  plugins: [
    dts({
      exclude: ['**/*.spec.ts', '**/*.test.ts', '**/*.test-d.ts', '**/test-utils.ts'],
      beforeWriteFile: relativizeTildeImports(resolve(__dirname, 'dist')),
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
      },
      formats: ['es'],
    },
    minify: true,
    // Maps are not published, so the built files must not point to them.
    sourcemap: 'hidden',
    rollupOptions: {
      // `node:*` builtins are provided by the Workers runtime (nodejs_compat);
      // keep them external so the bundler never stubs them out.
      external: [/^cloudflare:workers$/, /^node:/, /^@livething\/server(?:\/.*)?$/],
    },
  },
});
