import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  // The first test of a file also starts the Worker and its object, which can pass 5 s on a busy machine.
  test: { testTimeout: 20_000 },
});
