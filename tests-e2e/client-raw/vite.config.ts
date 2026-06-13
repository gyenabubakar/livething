import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      // The ws target is just a URL — the adapter behind it is irrelevant here.
      '/ws': {
        target: `http://127.0.0.1:${process.env.WSKIT_E2E_SERVER_PORT ?? 8787}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
