/**
 * Rules on what a package entry loads, however far down the import is. They follow imports
 * all the way, so they need a graph without `import type` edges (which ship no code) and with
 * the packages in it. The main config keeps both the other way round, so these live here.
 */

const base = require('./.dependency-cruiser.cjs');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'collaboration-shared-entry-no-yjs',
      comment:
        "The Collaboration plugin's shared entry (`doc()`, `text()`, ...) must not load Yjs or " +
        'fast-diff: code that only describes a doc should not ship the doc engine. Move what the ' +
        'entry needs into a leaf module, as `doc/thenable.ts` is.',
      severity: 'error',
      from: { path: '^plugins/collaboration/src/index\\.ts$' },
      to: { path: 'node_modules/(yjs|fast-diff)/', reachable: true },
    },
  ],
  options: {
    ...base.options,
    tsPreCompilationDeps: false,
    exclude: { path: '\\.(spec|test|test-d|bench)\\.ts$' },
  },
};
