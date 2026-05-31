import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Separate project from the default Node vitest run. Runs inside real workerd
// (Cloudflare's runtime) so storage tests hit genuine Durable Object SQLite.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
  test: {
    include: ['test/**/*.workers.spec.ts'],
  },
});
