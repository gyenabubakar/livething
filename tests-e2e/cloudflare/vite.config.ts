import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { SHARDS } from './shards.ts';

const wsProxy = Object.fromEntries(
  SHARDS.flatMap(({ port, routes }) =>
    routes.map((route) => [
      `/ws/${route}`,
      { target: `http://127.0.0.1:${port}`, changeOrigin: true, ws: true },
    ]),
  ),
);

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    proxy: wsProxy,
  },
});
