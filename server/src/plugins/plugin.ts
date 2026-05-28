/* oxlint-disable @typescript-eslint/no-explicit-any */

import { definePlugin } from '~/plugins/define.ts';
import type {
  ErrorContractDef,
  OutgoingDef,
  ScheduledDef,
  TypeMarker,
} from '~/_api/definitions.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type {
  PluginContextFactory,
  PluginFactory,
  PluginHooks,
  PluginInstance,
} from '~/plugins/define.ts';
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

/** Collapse a union into an intersection — used to fold per-def records into one map. */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/**
 * Extract a typed map of `{ eventName: payloadType }` from a plugin's
 * definitions tuple. Preserves literal event names and the inferred payload
 * type so the host contract can fold these into its outgoing slot with real
 * types instead of an index signature.
 */
type ExtractPluginOutgoing<TDefs> = TDefs extends readonly (infer D)[]
  ? UnionToIntersection<
      D extends OutgoingDef<infer TName, infer TPayload> ? { [K in TName]: TPayload } : {}
    >
  : {};

/**
 * Extract the union of declared error definitions from a plugin's definitions
 * tuple so the contract's error map can include plugin error codes with their
 * detail types.
 */
type ExtractPluginErrors<TDefs> = TDefs extends readonly (infer D)[]
  ? D extends ErrorDef<string, any>
    ? D
    : never
  : never;

/**
 * Extract the union of `{ name: <literal task name> }` entries from a
 * plugin's definitions tuple. The host contract reads `plugin.scheduled`
 * to surface plugin task ids under `ctx.schedule` with literal keys; the
 * union distributes inside the contract-side extractor.
 */
type ExtractPluginScheduledEntry<TDefs> = TDefs extends readonly (infer D)[]
  ? D extends ScheduledDef<infer TId, any>
    ? { readonly name: TId }
    : never
  : never;

export interface PluginConfig<TArgs, TCtx = any, TApi = unknown> {
  /**
   * Phantom marker for the args shape passed to `setup`. Use `t<{ ... }>()`
   * (re-exported from `@wskit/server`) so TS can infer TArgs from the config
   * without you having to spell it as an explicit generic argument.
   */
  readonly args?: TypeMarker<TArgs>;
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
 * export const Drizzle = plugin('acme:drizzle', {
 *   args: t<{ migrate: boolean }>(),
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
 * const c = contract('chat', {
 *   env: t<Env>(),
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
export function plugin<
  const TId extends string,
  TArgs = void,
  TApi = unknown,
  const TDefs extends readonly PluginDefinition[] = readonly [],
>(
  id: TId,
  // Every type parameter is inferred from the call site — never given as an
  // explicit generic argument. TId comes from the `id` literal. TArgs comes
  // from the `args: t<T>()` field (the same TypeMarker the contract uses for
  // `meta`). TApi falls out of setup's return value. TDefs is the
  // const-narrowed definitions tuple. Inferring everything keeps the call
  // shape generic-free, so partial generic args can't cut off inference for
  // the remaining ones.
  config: Omit<PluginConfig<TArgs, any, TApi>, 'definitions' | 'setup' | 'args'> & {
    readonly args?: TypeMarker<TArgs>;
    readonly definitions?: TDefs;
    readonly setup: (args: TArgs, hooks: PluginHooks<any>) => PluginContextFactory<any, TApi>;
  },
): PluginFactory<
  TId,
  TArgs,
  TApi,
  ExtractPluginOutgoing<TDefs>,
  readonly ExtractPluginErrors<TDefs>[],
  ExtractPluginScheduledEntry<TDefs> extends never
    ? { readonly name: string }
    : ExtractPluginScheduledEntry<TDefs> & { readonly name: string }
> {
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

  const inner = definePlugin({
    id,
    key: Symbol(id),
    requires: config.requires,
    outgoing: outgoingMap as any,
    errors: errorDefs.length > 0 ? ({ defs: errorDefs } as ErrorsPrimitive<any>) : undefined,
    setup: config.setup,
  }) as PluginFactory<string, TArgs, TApi, any, readonly ErrorDef<string, any>[]>;

  // Wrap so every instance the user creates carries the contract-feature
  // dependency list AND the declared scheduled-task list. compile reads
  // `instance.dependencies` to validate the contract enabled each feature;
  // initialize reads `instance.scheduled` to confirm setup() wired a handler
  // for every declared task.
  const dependencies = (config.dependencies ?? []) as readonly string[];
  const scheduledNames = (scheduledDefs as readonly ScheduledDef<string, any>[]).map((d) => ({
    name: d.id,
  }));
  const factory = Object.assign(
    ((args: TArgs) => {
      const instance = inner(args);
      // Mutate via cast — the fields are `readonly` on the public type to
      // discourage product code from touching them; only the wrapper writes.
      const writable = instance as unknown as {
        id: TId;
        dependencies: readonly string[];
        scheduled: readonly { readonly name: string }[];
      };
      writable.id = id;
      writable.dependencies = dependencies;
      writable.scheduled = scheduledNames;
      return instance as unknown as PluginInstance<
        TId,
        TArgs,
        TApi,
        ExtractPluginOutgoing<TDefs>,
        readonly ExtractPluginErrors<TDefs>[],
        ExtractPluginScheduledEntry<TDefs> extends never
          ? { readonly name: string }
          : ExtractPluginScheduledEntry<TDefs> & { readonly name: string }
      >;
    }) as unknown as PluginFactory<
      TId,
      TArgs,
      TApi,
      ExtractPluginOutgoing<TDefs>,
      readonly ExtractPluginErrors<TDefs>[],
      ExtractPluginScheduledEntry<TDefs> extends never
        ? { readonly name: string }
        : ExtractPluginScheduledEntry<TDefs> & { readonly name: string }
    >,
    {
      // Re-export the inner factory's `.use(ctx)` and id so the wrapper is
      // a drop-in replacement.
      use: inner.use,
      id: inner.id as TId,
      __key: inner.__key,
      __wskit_plugin_dependencies: dependencies,
      __wskit_plugin_scheduled: scheduledDefs,
    },
  );

  return factory;
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
