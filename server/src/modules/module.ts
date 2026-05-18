/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * `module()` — the public factory for defining a wskit module.
 *
 * Mirrors the contract shape: `requires`, optional `dependencies` (typed
 * contract feature flags), and a flat `definitions` array using the same
 * factories the contract uses (`outgoing`, `scheduled`, `error`). The
 * `setup(args, hooks)` callback returns the per-connection API; that return
 * type is inferred so handlers see typed values from `<Module>.use(ctx)`.
 */

import { defineModule } from '~/modules/define.ts';
import type { ErrorContractDef, OutgoingDef, ScheduledDef } from '~/_api/definitions.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { ModuleContextFactory, ModuleFactory, ModuleHooks } from '~/modules/define.ts';
import type { RequiresManifest } from '~/primitive.ts';

// `error('code', schema?)` from @wskit/core returns this — a callable factory
// PLUS code metadata. Modules accept either this or a contract-style
// ErrorContractDef.
type ErrorLike = { readonly code: string; readonly schema?: unknown } | ErrorDef<string, any>;

/**
 * Feature flags a module can declare a dependency on. Boot checks that the
 * contract using this module turned them on.
 */
export type ModuleDependency =
  | 'ack'
  | 'replay'
  | 'persistence'
  | 'sequence'
  | 'dedup'
  | 'hibernation'
  | 'heartbeat'
  | 'binary';

/**
 * Definitions a module is allowed to declare. Modules expose outgoing events,
 * scheduled tasks, and errors — they do not register incoming handlers
 * (use `hooks.onIncoming` for cross-cutting message observation).
 */
type ModuleDefinition =
  | OutgoingDef<string, any>
  | ScheduledDef<string, any>
  | ErrorContractDef<string, any>
  | ErrorLike;

export interface ModuleConfig<TArgs, TCtx = any, TApi = unknown> {
  /** Adapter capability check — fails fast at boot if missing. */
  readonly requires?: RequiresManifest;
  /**
   * Contract-level feature flags the module needs the host contract to enable.
   * Boot checks that each named feature is `true` in the contract config.
   * Typos and bogus names are type errors.
   */
  readonly dependencies?: readonly ModuleDependency[];
  /**
   * Module-owned declarations. Use the same factories the contract uses:
   * `outgoing(...)`, `scheduled(...)`, `error(...)`. Module-owned event and
   * task names are auto-namespaced as `__<id>:<name>` on the wire.
   */
  readonly definitions?: readonly ModuleDefinition[];
  /**
   * Wire the module into the engine and return the per-connection API
   * factory. The return type of `(ctx) => api` is inferred and surfaces
   * through `<Module>.use(ctx)`.
   */
  readonly setup: (args: TArgs, hooks: ModuleHooks<TCtx>) => ModuleContextFactory<TCtx, TApi>;
}

/**
 * Create a wskit module.
 *
 * @example
 * ```ts
 * import { module, outgoing, scheduled, error, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const Denied = error('drizzle/denied', v.object({ reason: v.string() }));
 *
 * export const Drizzle = module<{ migrate: boolean }>('acme:drizzle')({
 *   requires: { storage: true },
 *   dependencies: ['persistence'],
 *   definitions: [
 *     outgoing('drizzle-ready', v.object({ tables: v.array(v.string()) })),
 *     scheduled('drizzle-vacuum', { every: 60_000 }),
 *     Denied,
 *   ],
 *   setup(args, hooks) {
 *     hooks.onInit((ctx) => { ... });
 *     hooks.scheduled('drizzle-vacuum', (t) => t.run(async (ctx) => { ... }));
 *     return (ctx) => ({
 *       insert: (row) => { ... },
 *       findAll: () => { ... },
 *     });
 *   },
 * });
 *
 * // Mount onto a contract:
 * const c = contract<Env>('chat')({
 *   persistence: true,
 *   modules: [Drizzle({ migrate: true })],
 *   definitions: [...],
 * });
 *
 * // Use inside a handler:
 * implement(c).on('insert-record', (ctx, payload) => {
 *   const db = Drizzle.use(ctx);
 *   db.insert(payload);
 * });
 * ```
 */
export function module<TArgs = void>(id: string) {
  return function moduleConfig<TApi>(
    config: ModuleConfig<TArgs, any, TApi>,
  ): ModuleFactory<string, TArgs, TApi, any, readonly ErrorDef<string, any>[]> {
    // Extract outgoing schemas + scheduled-task IDs + errors for the legacy
    // defineModule shape.
    const outgoingMap: Record<string, unknown> = {};
    const errorDefs: ErrorDef<string, any>[] = [];

    for (const def of config.definitions ?? []) {
      const d = def as { _?: string; name?: string; schema?: unknown; code?: string };
      if (d._ === 'outgoing') {
        outgoingMap[d.name!] = d.schema;
      } else if (d._ === 'error' || (d.code && d._ === undefined)) {
        // ErrorContractDef or ErrorDefWithFactory — both carry `code`.
        errorDefs.push(def as unknown as ErrorDef<string, any>);
      }
    }

    // Stash declared scheduled task IDs on the factory so the contract type
    // system (and the boot-time module dependency check) can read them off
    // the module instance.
    const scheduledDefs = (config.definitions ?? []).filter(
      (d): d is ScheduledDef<string, any> => (d as { _?: string })._ === 'scheduled',
    );

    const factory = defineModule({
      id,
      key: Symbol(id),
      requires: config.requires,
      outgoing: outgoingMap as any,
      errors: errorDefs.length > 0 ? ({ defs: errorDefs } as ErrorsPrimitive<any>) : undefined,
      setup: config.setup,
    }) as ModuleFactory<string, TArgs, TApi, any, readonly ErrorDef<string, any>[]>;

    // Attach declarative metadata so the contract layer can read it back.
    Object.assign(factory, {
      __wskit_module_dependencies: config.dependencies ?? [],
      __wskit_module_scheduled: scheduledDefs,
    });

    return factory;
  };
}

/**
 * Re-export `defineModule` for now during the migration so any code that
 * still imports it keeps working. New code should use `module()` above.
 *
 * @deprecated Use `module(id)({...})` from `@wskit/server` instead.
 */
export { defineModule } from '~/modules/define.ts';

/**
 * Definition factories that pass through to the contract API — re-exported
 * here so module authors can declare module-owned `outgoing`, `scheduled`,
 * and `error` items using the same factories as a contract.
 */
export { outgoing, scheduled, error } from '~/_api/definitions.ts';
