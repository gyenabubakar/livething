/* oxlint-disable @typescript-eslint/no-explicit-any */

import { namespaceError } from '@wskit/core';
import { collectUnique } from '~/_engine/compile/utils.ts';
import { definePlugin } from '~/plugins/define.ts';
import type { OutgoingDef, ScheduledDef, TypeMarker } from '~/_api/definitions.ts';
import type {
  PluginContextFactory,
  PluginErrorMap,
  PluginFactory,
  PluginHooks,
  PluginInstance,
} from '~/plugins/define.ts';
import type { RequiresManifest } from '~/primitive.ts';

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
  | 'keepalive'
  | 'binary';

/**
 * Definitions a plugin is allowed to declare. Plugins expose outgoing events
 * and scheduled tasks here — they do not register incoming handlers (use
 * `hooks.onIncoming` for cross-cutting message observation). Errors are
 * declared separately in the `errors: { ... }` map so the engine can namespace
 * their codes.
 */
type PluginDefinition = OutgoingDef<string, any> | ScheduledDef<string, any>;

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
   * The plugin's own errors, declared with short names. The engine namespaces
   * each code to `__<id>:<name>` so it can't clash with a handler's error of
   * the same name. Throw them via `hooks.errors.<name>(...)`, and match them
   * from outside with `MyPlugin.errors.<name>.matches(err)`.
   */
  readonly errors?: PluginErrorMap;
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
 * export const Drizzle = plugin('acme:drizzle', {
 *   args: t<{ migrate: boolean }>(),
 *   requires: { storage: true },
 *   dependencies: ['persistence'],
 *   // Errors are declared here with short names. The engine namespaces each
 *   // code to `__acme:drizzle:<name>`, so it can't clash with a handler's own.
 *   errors: {
 *     denied: error('denied', v.object({ reason: v.string() })),
 *   },
 *   definitions: [
 *     outgoing('drizzle-ready', v.object({ tables: v.array(v.string()) })),
 *     scheduled('drizzle-vacuum', { every: 60_000 }),
 *   ],
 *   setup(args, hooks) {
 *     hooks.onInit((ctx) => { ... });
 *     hooks.scheduled('drizzle-vacuum', (t) => t.run(async (ctx) => { ... }));
 *     // Throw the plugin's own error from a hook:
 *     hooks.onConnect((ctx) => { if (blocked) throw hooks.errors.denied({ reason: 'blocked' }); });
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
 * // Match the plugin's error from anywhere: Drizzle.errors.denied.matches(err)
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
  TErrors extends PluginErrorMap = {},
>(
  id: TId,
  // Every type parameter is inferred from the call site — never given as an
  // explicit generic argument. TId comes from the `id` literal. TArgs comes
  // from the `args: t<T>()` field (the same TypeMarker the contract uses for
  // `meta`). TApi falls out of setup's return value. TDefs is the
  // const-narrowed definitions tuple. TErrors is the const-narrowed errors map.
  // Inferring everything keeps the call shape generic-free, so partial generic
  // args can't cut off inference for the remaining ones.
  config: Omit<PluginConfig<TArgs, any, TApi>, 'definitions' | 'setup' | 'args' | 'errors'> & {
    readonly args?: TypeMarker<TArgs>;
    readonly definitions?: TDefs;
    readonly errors?: TErrors;
    // `hooks` is typed loosely here on purpose: mentioning TErrors in this
    // parameter position makes it compete with the `errors` map to infer
    // TErrors, which collapses it to `{}`. Inside setup, `hooks.errors.<name>`
    // is still callable; the fully-typed factories are on `Plugin.errors`.
    readonly setup: (args: TArgs, hooks: PluginHooks<any>) => PluginContextFactory<any, TApi>;
  },
): PluginFactory<
  TId,
  TArgs,
  TApi,
  ExtractPluginOutgoing<TDefs>,
  TErrors,
  ExtractPluginScheduledEntry<TDefs> extends never
    ? { readonly name: string }
    : ExtractPluginScheduledEntry<TDefs> & { readonly name: string }
> {
  // Split the flat `definitions` array into the per-kind buckets `definePlugin` accepts.
  const allDefs = config.definitions ?? [];
  const outgoingDefsRaw = allDefs.filter(
    (d) => (d as { _?: string })._ === 'outgoing',
  ) as readonly { name: string; schema?: unknown }[];
  const scheduledDefsRaw = allDefs.filter(
    (d) => (d as { _?: string })._ === 'scheduled',
  ) as readonly ScheduledDef<string, any>[];

  collectUnique(outgoingDefsRaw, (d) => d.name, {
    kind: 'outgoing',
    context: `plugin("${id}")`,
  });
  const scheduledDefs = collectUnique(scheduledDefsRaw, (d) => d.id, {
    kind: 'scheduled',
    context: `plugin("${id}")`,
  });

  const outgoingMap: Record<string, unknown> = {};
  for (const d of outgoingDefsRaw) outgoingMap[d.name] = d.schema;

  // Namespace each declared error to `__<id>:<name>`, reusing its detail
  // schema. The author throws/matches via these factories; the prefixed code
  // is what reaches the wire and the declared-error set, so it can never
  // collide with a handler's error of the same short name.
  const prefixedErrors: PluginErrorMap = {};
  for (const [name, def] of Object.entries(config.errors ?? {})) {
    prefixedErrors[name] = namespaceError(`__${id}:${name}`, def);
  }

  const inner = definePlugin({
    id,
    key: Symbol(id),
    requires: config.requires,
    outgoing: outgoingMap as any,
    errors: prefixedErrors,
    setup: config.setup as any,
  }) as PluginFactory<string, TArgs, TApi, any, PluginErrorMap>;

  // Wrap so every instance the user creates carries the contract-feature
  // dependency list AND the declared scheduled-task list. compile reads
  // `instance.dependencies` to validate the contract enabled each feature;
  // initialize reads `instance.scheduled` to confirm setup() wired a handler
  // for every declared task.
  const dependencies = (config.dependencies ?? []) as readonly string[];
  // Carry the full ScheduledDef alongside the name so initialize can
  // cross-check the declared data schema against the runtime registration
  // and catch a hooks.scheduled() that forgot .data(schema).
  const scheduledNames = scheduledDefs.map((d) => ({ name: d.id, declaration: d }));
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
        TErrors,
        ExtractPluginScheduledEntry<TDefs> extends never
          ? { readonly name: string }
          : ExtractPluginScheduledEntry<TDefs> & { readonly name: string }
      >;
    }) as unknown as PluginFactory<
      TId,
      TArgs,
      TApi,
      ExtractPluginOutgoing<TDefs>,
      TErrors,
      ExtractPluginScheduledEntry<TDefs> extends never
        ? { readonly name: string }
        : ExtractPluginScheduledEntry<TDefs> & { readonly name: string }
    >,
    {
      // Re-export the inner factory's `.use(ctx)`, id, and namespaced errors so
      // the wrapper is a drop-in replacement.
      use: inner.use,
      id: inner.id as TId,
      __key: inner.__key,
      errors: prefixedErrors as TErrors,
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
