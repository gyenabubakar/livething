/**
 * Mechanical guard for wskit's tree-shaking architecture (server spec §24).
 *
 * The `@wskit/server` package splits into one bundle entry per feature. Each
 * `<feature>/capability.ts` is that entry; whatever it statically value-imports
 * lands in the bundle when a user imports the feature. Two import directions
 * would defeat the split, so both are forbidden here:
 *
 *  1. `core-no-feature-capability` — the engine CORE (`server/src/_engine/**`)
 *     must never value-import a feature's `capability.ts`. Core exposes seams
 *     (`__streamBuild` / `__buildRateLimit` / `__durableSweep`, the
 *     `ChannelDeps` builders); features import core, never the reverse. Core
 *     MAY value-import a feature's `runtime.ts` / `context.ts` / `compile.ts` —
 *     those are seam targets pulled in only when that engine path runs — so the
 *     rule targets `capability.ts` entry points only.
 *
 *  2. `capability-no-cross-feature-engine` — one feature's `capability.ts` must
 *     never value-import a DIFFERENT feature's `capability.ts` or `runtime.ts`.
 *     Those are the heavy engine modules; a value edge between two entries drags
 *     one feature's engine into another feature's bundle. This one rule covers
 *     every feature pair (15 × 15), replacing the old per-pair stream/channel
 *     rules. Legitimate sharing still works: leaf modules (`stream/shared.ts`,
 *     `<feature>/durable-config.ts`, markers, small primitives) are not
 *     `capability.ts`/`runtime.ts`, so a feature that genuinely depends on
 *     another — a durable stream on `scheduled`, `channels` on an `intercept`
 *     primitive — imports the leaf directly and stays clean.
 *
 * Type-only imports (`import type`) are ignored everywhere — they carry no
 * runtime code and cannot leak into a bundle.
 *
 * `_`-prefixed folders (`_engine`, `_define`, `_adapters`) are internal
 * plumbing, not features, so they are excluded from the feature rules.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'server-core-no-adapter-import',
      comment:
        'The portable server package must depend on adapter interfaces, never an adapter implementation. ' +
        'Put runtime-specific behavior in server-adapters instead.',
      severity: 'error',
      from: {
        path: '^server/src/',
      },
      to: {
        path: '^server-adapters/',
      },
    },
    {
      name: 'core-no-feature-capability',
      comment:
        'Engine core must not value-import a feature capability module. Core exposes seams; ' +
        'features import core, never the reverse. Import the feature runtime/compile module if ' +
        'core needs a seam target, or move the dependency behind an assemble-time builder.',
      severity: 'error',
      from: {
        path: '^server/src/_engine/',
        pathNot: '\\.(spec|test|test-d|bench)\\.ts$',
      },
      to: {
        path: '^server/src/(?!_)[^/]+/capability\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'capability-no-cross-feature-engine',
      comment:
        "A feature's capability.ts (its bundle entry) must not value-import another feature's " +
        "capability.ts or runtime.ts — that would pull the other feature's engine into this " +
        "feature's bundle and defeat the per-capability split. Depend on the other feature's " +
        'shared leaf module instead (e.g. stream/shared.ts), or keep the edge `import type` only.',
      severity: 'error',
      from: {
        path: '^server/src/(?!_)([^/]+)/capability\\.ts$',
      },
      to: {
        path: '^server/src/(?!_)[^/]+/(capability|runtime)\\.ts$',
        pathNot: '^server/src/$1/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'define-no-plugin-entry-runtime',
      comment:
        '`_define/plugin.ts` is a bundle entry, so rollup keeps the module whole rather than ' +
        'shaking within it. A single value import from `define.ts` therefore lands the plugin ' +
        'runtime — the wire-namespacing pass and the plugin-scoped context — in the emitted graph ' +
        'of the main `.` entry, which every app loads. Import the assemble-time checks from ' +
        '`_define/plugin-checks.ts`, or keep the edge `import type` only.',
      severity: 'error',
      from: {
        path: '^server/src/_define/define\\.ts$',
      },
      to: {
        path: '^server/src/_define/plugin\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'client-utility-entry-no-runtime',
      comment:
        'A client utility subpath (`errors`, `environment`, `platform`) must not value-import the ' +
        'connection runtime (socket, connect, client, messaging, or the plugin system). Importing ' +
        '`@wskit/client/errors` should ship error classes, not a WebSocket engine. Keep the edge ' +
        '`import type` only, or move the shared piece to a leaf module the runtime also uses.',
      severity: 'error',
      from: {
        path: '^client/src/(errors|environment|platform)\\.ts$',
      },
      to: {
        path: '^client/src/(socket/|connect\\.ts|client\\.ts|messaging\\.ts|plugins/)',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'client-no-test-helpers-in-runtime',
      comment:
        'Production client code must not value-import the test-only entries (`testing.ts`, the ' +
        "public test-utility subpath, or the internal `test-helpers.ts`). They exist for consumers' " +
        "and wskit's own tests; pulling them into the runtime graph ships mock/injection code to " +
        'every app. Keep such imports inside spec files.',
      severity: 'error',
      from: {
        path: '^client/src/',
        pathNot: '^client/src/(testing|test-helpers)\\.ts$',
      },
      to: {
        path: '^client/src/(testing|test-helpers)\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '(^|/)(node_modules|dist)/|\\.(spec|test|test-d|bench)\\.ts$',
    },
    tsPreCompilationDeps: true,
    // Resolve each package's `~/*` alias so cross-module edges are seen. A
    // dedicated tsconfig (no `include`, so TS does not error on "no inputs"
    // when run from the repo root) carries only the path mapping.
    tsConfig: {
      fileName: '.dependency-cruiser.tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.d.ts'],
    },
  },
};
