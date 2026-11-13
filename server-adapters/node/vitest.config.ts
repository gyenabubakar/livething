import { defineConfig } from 'vitest/config';

// The specs that use `openRawClient` run a second time with their raw clients over SSE.
const SSE_SPECS = [
  'src/server.integration.spec.ts',
  'src/replay.integration.spec.ts',
  'src/user-transaction.integration.spec.ts',
  'src/binary.integration.spec.ts',
  'src/frameworks/**/index.integration.spec.ts',
];

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'websocket', include: ['src/**/*.spec.ts'] } },
      {
        extends: true,
        test: { name: 'sse', include: SSE_SPECS, env: { LIVETHING_TEST_TRANSPORT: 'sse' } },
      },
    ],
  },
});
