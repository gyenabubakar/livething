import { resolve } from 'path';
import { defineConfig } from 'vite';
import { wskitCodegen } from '../server-vite/src/index.ts';

export default defineConfig({
  plugins: [
    wskitCodegen({
      include: ['src/**/*.wskit.ts'],
    }),
  ],
  resolve: {
    alias: [
      {
        find: /^@wskit\/server-codegen\/(.+)$/,
        replacement: resolve(__dirname, '../server-codegen/src/$1/index.ts'),
      },
      {
        find: '@wskit/server-codegen',
        replacement: resolve(__dirname, '../server-codegen/src/index.ts'),
      },
      {
        find: '@wskit/core',
        replacement: resolve(__dirname, '../../core/src/index.ts'),
      },
      {
        find: '@wskit/shared',
        replacement: resolve(__dirname, '../../shared/src/index.ts'),
      },
    ],
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['es'],
    },
  },
});
