import { resolve } from 'path';
import { wskitCodegen } from '@wskit/server-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    wskitCodegen({
      include: ['src/**/*.wskit.ts'],
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        '@wskit/core',
        '@wskit/shared',
        '@wskit/server-codegen',
        /^@wskit\/server-codegen\/.+$/,
        '@wskit/server-vite',
      ],
    },
  },
});
