/* oxlint-disable @typescript-eslint/no-explicit-any */

import { definePlugin } from '~/plugins/define.ts';
import type { ErrorContractDef, OutgoingDef, ScheduledDef } from '~/_api/definitions.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { PluginContextFactory, PluginFactory, PluginHooks } from '~/plugins/define.ts';
import type { RequiresManifest } from '~/primitive.ts';

// `error('code', schema?)` from @wskit/core returns this — a callable factory
// PLUS code metadata. Plugins accept either this or a contract-style
// ErrorContractDef.
type ErrorLike = { readonly code: string; readonly schema?: unknown } | ErrorDef<string, any>;

/**
 * Feature flags a plugin can declare a dependency on. Boot checks that the
 * contract using this plugin turned them on.
 */
export type PluginDependency =
  | 'ack'
  | 'replay'
  | 'persistence'
  | 'sequence'
  | 'dedup'
  | 'hibernation'
  | 'heartbeat'
  | 'binary';

/**
 * Definitions a plugin is allowed to declare. Plugins expose outgoing events,
 * scheduled tasks, and errors — they do not register incoming handlers
 * (use `hooks.onIncoming` for cross-cutting message observation).
 */
type PluginDefinition =
  | OutgoingDef<string, any>
  | ScheduledDef<string, any>
  | ErrorContractDef<string, any>
  | ErrorLike;

export interface PluginConfig<TArgs, TCtx = any, TApi = unknown> {
  /** Adapter capability check — fails fast at boot if missing. */
  readonly requires?: RequiresManifest;
  /**
   * Contract-level feature flags the plugin needs the host contract to enable.
   * Boot checks that each named feature is `true` in the contract config.
   * Typos and bogus names are type errors.
   */
  readonly dependencies?: readonly PluginDependency[];
  /**
   * Plugin-owned declarations. Use the same factories the contract uses:
   * `outgoing(...)`, `scheduled(...)`, `error(...)`. Plugin-owned event and
   * task names are auto-namespaced as `__<id>:<name>` on the wire.
   */
  readonly definitions?: readonly PluginDefinition[];
  /**
   * Wire the plugin into the engine and return the per-connection API
   * factory. The return type of `(ctx) => api` is inferred and surfaces
   * through `<Plugin>.use(ctx)`.
   */
  readonly setup: (args: TArgs, hooks: PluginHooks<TCtx>) => PluginContextFactory<TCtx, TApi>;
}

/**
 * Create a wskit plugin.
 *
 * @example
 * ```ts
 * import { plugin, outgoing, scheduled, error, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const Denied = error('drizzle/denied', v.object({ reason: v.string() }));
 *
 * export const Drizzle = plugin<{ migrate: boolean }>('acme:drizzle')({
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
 *   plugins: [Drizzle({ migrate: true })],
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
export function plugin<TArgs = void>(id: string) {
  return function pluginConfig<TApi>(
    config: PluginConfig<TArgs, any, TApi>,
  ): PluginFactory<string, TArgs, TApi, any, readonly ErrorDef<string, any>[]> {
    // Split the flat `definitions` array into the per-kind buckets `definePlugin` accepts.
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
    // system (and the boot-time plugin dependency check) can read them off
    // the plugin instance.
    const scheduledDefs = (config.definitions ?? []).filter(
      (d): d is ScheduledDef<string, any> => (d as { _?: string })._ === 'scheduled',
    );

    const factory = definePlugin({
      id,
      key: Symbol(id),
      requires: config.requires,
      outgoing: outgoingMap as any,
      errors: errorDefs.length > 0 ? ({ defs: errorDefs } as ErrorsPrimitive<any>) : undefined,
      setup: config.setup,
    }) as PluginFactory<string, TArgs, TApi, any, readonly ErrorDef<string, any>[]>;

    // Attach declarative metadata so the contract layer can read it back.
    Object.assign(factory, {
      __wskit_plugin_dependencies: config.dependencies ?? [],
      __wskit_plugin_scheduled: scheduledDefs,
    });

    return factory;
  };
}

/**
 * `definePlugin` is the lower-level factory `plugin()` wraps. Kept exported
 * because the engine still references its types internally.
 */
export { definePlugin } from '~/plugins/define.ts';
export type {
  PluginContextFactory,
  PluginFactory,
  PluginHooks,
  PluginInstance,
} from '~/plugins/define.ts';
