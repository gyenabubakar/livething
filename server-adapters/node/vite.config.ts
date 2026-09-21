import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { relativizeTildeImports } from '../../scripts/vite-dts.ts';

export default defineConfig({
  plugins: [
    dts({
      exclude: ['**/*.spec.ts', '**/*.test.ts', '**/*.test-d.ts'],
      beforeWriteFile: relativizeTildeImports(resolve(__dirname, 'dist')),
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        binding: resolve(__dirname, 'src/binding.ts'),
        hono: resolve(__dirname, 'src/frameworks/hono/index.ts'),
        fastify: resolve(__dirname, 'src/frameworks/fastify/index.ts'),
        h3: resolve(__dirname, 'src/frameworks/h3/index.ts'),
        'h3-v1': resolve(__dirname, 'src/frameworks/h3/v1/index.ts'),
      },
      formats: ['es'],
    },
    minify: true,
    sourcemap: true,
    rollupOptions: {
      external: [
        /^node:/,
        /^@fastify\/websocket$/,
        /^@hono\/node-server$/,
        /^@livething\/server(?:\/.*)?$/,
        /^better-sqlite3$/,
        /^crossws(?:\/.*)?$/,
        /^fastify$/,
        /^h3(?:\/.*)?$/,
        /^hono(?:\/.*)?$/,
        /^ws$/,
      ],
    },
  },
});
