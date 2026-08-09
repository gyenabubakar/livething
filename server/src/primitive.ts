/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EngineAccess } from './_engine/access.ts';

/**
 * The category tag every primitive carries. Set automatically by each
 * primitive factory — you never assign it yourself.
 */
export type PrimitiveKind =
  | 'handler'
  | 'contract'
  | 'infrastructure'
  | 'lifecycle'
  | 'scope'
  | 'plugin';

/**
 * Declares whether a primitive needs hibernation support — a platform
 * capability not every adapter has. When a primitive sets `hibernation: true`
 * and the adapter does not support it, the server fails to start with a clear
 * error — before any connection is accepted.
 *
 * ```ts
 * // A primitive that needs hibernation support:
 * const requires: RequiresManifest = { hibernation: true };
 * ```
 */
export interface RequiresManifest {
  hibernation?: boolean;
}

/**
 * Read-only view of settled engine state, passed to a primitive's `__validate`
 * hook. It exposes only derived facts a primitive needs to check its own
 * runtime requirements — not the engine internals — so validation stays
 * encapsulated in the capability that owns the rule.
 */
export interface ValidationView {
  /** Whether a persistent `sequence` is configured. */
  readonly sequencePersistent: boolean;
  /** The channel key this primitive is scoped to, if any. */
  readonly channelKey?: string;
  /** Whether the named channel persists its membership. */
  isChannelPersistent(channelKey: string): boolean;
}

/**
 * Lightweight marker used by factories that need a stable symbol-typed
 * identity. Kept as a separate type for plugin() factory typing.
 *
 * @internal
 */
export interface PrimitiveRef {
  readonly __key: symbol;
}

/**
 * The identity descriptor for a primitive. Set automatically by each primitive
 * factory — you do not interact with this directly.
 */
export type PrimitiveIdentity =
  | readonly [key: symbol]
  | readonly [key: symbol, registrationId: string];

/**
 * Base type for every primitive. Every primitive factory (a capability like
 * `requests()`, or an internal builder behind `base.on(...)` / `base.channel(...)`)
 * returns an object that extends `Primitive`.
 *
 * You rarely need to reference this type directly — use it to annotate a
 * variable or function parameter that must accept any WSKit primitive.
 */
export interface Primitive<Tag extends string = string> {
  readonly __wskit: Tag;
  readonly __kind: PrimitiveKind;
  readonly __identity: PrimitiveIdentity;
  readonly __requires: RequiresManifest;
  /**
   * Capability identity tokens (see `CAPABILITY_KIND`) this primitive needs
   * listed in the same `define({ capabilities })`. Resolved at `assemble()`:
   * a missing one is a build error on an app, and on a plugin a host-owned
   * requirement is auto-recorded as a host dependency. Empty by default.
   * @internal
   */
  readonly __requiresCapabilities?: readonly string[];

  /** @internal */
  readonly __setup?: (engine: EngineAccess) => void;
  /**
   * Assert this primitive's runtime-state requirements against settled engine
   * state. Runs once at startup, after every primitive's `__setup`, so it reads
   * facts other primitives wrote (e.g. replay checks a persistent sequence).
   * Throw to fail startup with a clear message. @internal
   */
  readonly __validate?: (view: ValidationView) => void;
}

/**
 * Configuration passed to `definePrimitive`.
 *
 * @internal
 */
export interface PrimitiveConfig<
  TTag extends string,
  TArgs extends readonly any[],
  TData extends Record<string, any>,
> {
  readonly tag: TTag;
  readonly key: symbol;
  readonly kind: PrimitiveKind;

  /**
   * When provided, the factory is repeatable. It is called with the same
   * arguments the developer passed and must return a stable string ID (for
   * example, the event name). Two calls with the same ID throw a duplicate
   * registration error.
   *
   * When omitted, the primitive is a pure singleton — only one instance per
   * server handler is allowed.
   */
  readonly registrationId?: (...args: TArgs) => string;

  /**
   * Either a static manifest or a function that computes the manifest from
   * the factory's arguments. Use a function when the requirements depend on
   * what the developer passes (e.g. a primitive that needs storage only if
   * persistence is enabled).
   */
  readonly requires?: RequiresManifest | ((...args: TArgs) => RequiresManifest);

  /**
   * Capability identity tokens this primitive needs co-listed. Either a static
   * list or a function computing it from the factory's arguments (use the
   * function form when the requirement is conditional, e.g. persistent tag
   * groups need persistence but ephemeral ones do not).
   */
  readonly requiresCapabilities?: readonly string[] | ((...args: TArgs) => readonly string[]);

  /** Assert runtime-state requirements at startup. See `Primitive.__validate`. */
  readonly validate?: (view: ValidationView) => void;

  /** Transform the factory's arguments into the data stored on the primitive instance. */
  create(...args: TArgs): TData;

  /**
   * Wire this primitive into the engine. Called once during engine
   * initialization, after all primitives have been collected. `data` is
   * the output of `create()`.
   *
   * Built-in primitives receive full `EngineAccess`. User plugins only
   * receive `PluginHooks` — a restricted subset that cannot reach engine
   * internals.
   */
  setup?(engine: EngineAccess, data: TData): void;
}

/**
 * The type returned by `definePrimitive`.
 *
 * @internal
 */
export interface PrimitiveFactory<
  TTag extends string,
  TArgs extends readonly any[],
  TData extends Record<string, any>,
> extends PrimitiveRef {
  (...args: TArgs): Primitive<TTag> & TData;
}

/**
 * Create a built-in primitive factory.
 *
 * This is an internal WSKit API — product developers use `plugin()` to ship
 * custom behavior. `definePrimitive` is for the primitives that ship with
 * WSKit itself (incoming, channel, etc.).
 *
 * The returned factory function:
 * 1. When **called** — produces a `Primitive` instance with base fields
 *    merged together with the custom `TData` fields from `create()`.
 * 2. When **used as a ref** — acts as a `PrimitiveRef` so other primitives
 *    can declare it as a dependency.
 *
 * ```ts
 * const PING_KEY = Symbol('ping');
 *
 * const ping = definePrimitive({
 *   tag: 'ping',
 *   key: PING_KEY,
 *   kind: 'infrastructure',
 *   create() { return {}; },
 *   setup(engine) {
 *     engine.onIncoming((msg) => { ... });
 *     engine.extendContext((ctx) => ({
 *       ping() { engine.rawSend(ctx.connection.id, '__ping__', {}); }
 *     }));
 *   },
 * });
 * ```
 */
export function definePrimitive<
  TTag extends string,
  TArgs extends readonly any[],
  TData extends Record<string, any>,
>(config: PrimitiveConfig<TTag, TArgs, TData>): PrimitiveFactory<TTag, TArgs, TData> {
  function factory(...args: TArgs): Primitive<TTag> & TData {
    const identity: PrimitiveIdentity = config.registrationId
      ? [config.key, config.registrationId(...args)]
      : [config.key];

    const data = config.create(...args);
    const requires =
      typeof config.requires === 'function' ? config.requires(...args) : (config.requires ?? {});
    const requiresCapabilities =
      typeof config.requiresCapabilities === 'function'
        ? config.requiresCapabilities(...args)
        : (config.requiresCapabilities ?? []);

    return {
      __wskit: config.tag,
      __kind: config.kind,
      __identity: identity,
      __requires: requires,
      __requiresCapabilities: requiresCapabilities,
      __setup: config.setup ? (engine: EngineAccess) => config.setup!(engine, data) : undefined,
      __validate: config.validate,
      ...data,
    } as Primitive<TTag> & TData;
  }

  factory.__key = config.key;
  return factory as PrimitiveFactory<TTag, TArgs, TData>;
}
