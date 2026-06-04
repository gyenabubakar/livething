import { defineConfig } from 'vite';

// Serves the test page and proxies the WebSocket path to the puppet ws server,
// so the browser talks to a same-origin socket (and `context.setOffline` can
// cut it the way it would a real connection).
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4180,
    proxy: {
      '/wsx': { target: 'http://127.0.0.1:8788', ws: true, changeOrigin: true },
    },
  },
});
