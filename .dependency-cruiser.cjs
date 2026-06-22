/**
 * Mechanical guard for wskit's tree-shaking architecture (server spec §24).
 *
 * Two import directions break tree-shaking and are forbidden here:
 *
 *  1. The engine CORE (`server/src/_engine/**`) must never value-import a
 *     feature CAPABILITY module (`<feature>/capability.ts`). Core provides
 *     seams (`__streamBuild` / `__buildRateLimit` / `__durableSweep`, the
 *     `ChannelDeps` builders); features import core, never the reverse. Core is
 *     allowed to value-import a feature's `runtime.ts` / `context.ts` /
 *     `compile.ts` — those are the seam targets pulled in only when that engine
 *     path runs — so the rule targets `capability.ts` entry points only.
 *
 *  2. The `channels` capability must not value-import the stream or rate-limit
 *     capabilities, and one stream variant capability must not value-import
 *     another variant's capability or runtime. These are separate bundle
 *     entries; a value edge between them would defeat the per-capability split.
 *
 * Type-only imports (`import type`) are ignored everywhere — they carry no
 * runtime code and cannot leak into a bundle.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
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
        path: '^server/src/[^/]+/capability\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'channels-no-stream-or-ratelimit',
      comment:
        'The channels capability must not value-import the stream or rate-limit capabilities. It ' +
        'borrows their builders at assemble time via ChannelDeps / the rate-limit seam, so a ' +
        'channels-only app pays for neither. Keep these as `import type` only.',
      severity: 'error',
      from: {
        path: '^server/src/channel/capability\\.ts$',
      },
      to: {
        path: '^server/src/(stream|stream-resumable|stream-recorded|rate-limit)/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'stream-no-durable-variant',
      comment:
        'The plain stream capability must not value-import a durable stream variant. Each variant ' +
        'is its own bundle entry; importing only one must not pull the others. The plain stream ' +
        'capability may import its own runtime seam.',
      severity: 'error',
      from: {
        path: '^server/src/stream/capability\\.ts$',
      },
      to: {
        path: '^server/src/(stream-resumable|stream-recorded)/(capability|runtime)\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'resumable-stream-no-other-variant',
      comment:
        'The resumable stream capability must not value-import the plain or recorded stream ' +
        'variant capability/runtime. Shared helpers live in server/src/stream/shared.ts.',
      severity: 'error',
      from: {
        path: '^server/src/stream-resumable/capability\\.ts$',
      },
      to: {
        path: '^server/src/(stream|stream-recorded)/(capability|runtime)\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'recorded-stream-no-other-variant',
      comment:
        'The recorded stream capability must not value-import the plain or resumable stream ' +
        'variant capability/runtime. Shared helpers live in server/src/stream/shared.ts.',
      severity: 'error',
      from: {
        path: '^server/src/stream-recorded/capability\\.ts$',
      },
      to: {
        path: '^server/src/(stream|stream-resumable)/(capability|runtime)\\.ts$',
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
    // Resolve the server's `~/*` alias so cross-module edges are seen. A
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
