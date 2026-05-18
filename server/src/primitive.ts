/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EngineAccess } from './_engine/access.ts';

// ---------------------------------------------------------------------------
// Primitive kind
// ---------------------------------------------------------------------------

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
  | 'module';

// ---------------------------------------------------------------------------
// Platform requirements
// ---------------------------------------------------------------------------

/**
 * Declares which platform capabilities a primitive needs at runtime. When any
 * required capability is not provided by the adapter, the server fails to
 * start with a clear error — before any connection is accepted.
 *
 * ```ts
 * // A primitive that needs both SQL storage and timers:
 * const requires: RequiresManifest = { storage: true, timers: true };
 * ```
 */
export interface RequiresManifest {
  storage?: boolean;
  timers?: boolean;
  hibernation?: boolean;
}

/**
 * Lightweight marker used by factories that need a stable symbol-typed
 * identity. Kept as a separate type for module() factory typing.
 *
 * @internal
 */
export interface PrimitiveRef {
  readonly __key: symbol;
}

// ---------------------------------------------------------------------------
// Identity — singleton enforcement
// ---------------------------------------------------------------------------

/**
 * The identity descriptor for a primitive. Set automatically by each primitive
 * factory — you do not interact with this directly.
 */
export type PrimitiveIdentity =
  | readonly [key: symbol]
  | readonly [key: symbol, registrationId: string];

// ---------------------------------------------------------------------------
// Primitive instance — what factory functions return
// ---------------------------------------------------------------------------

/**
 * Base type for every primitive. Every factory function (`ack()`,
 * `incoming()`, `channel()`, etc.) returns an object that extends `Primitive`.
 *
 * You rarely need to reference this type directly — use it to annotate a
 * variable or function parameter that must accept any wskit primitive.
 */
export interface Primitive<Tag extends string = string> {
  readonly __wskit: Tag;
  readonly __kind: PrimitiveKind;
  readonly __identity: PrimitiveIdentity;
  readonly __requires: RequiresManifest;

  /** @internal */
  readonly __setup?: (engine: EngineAccess) => void;
}

// ---------------------------------------------------------------------------
// definePrimitive — create a built-in primitive factory
// ---------------------------------------------------------------------------

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

  /** Transform the factory's arguments into the data stored on the primitive instance. */
  create(...args: TArgs): TData;

  /**
   * Wire this primitive into the engine. Called once during engine
   * initialization, after all primitives have been collected. `data` is
   * the output of `create()`.
   *
   * Built-in primitives receive full `EngineAccess`. User modules only
   * receive `ModuleHooks` — a restricted subset that cannot reach engine
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
 * This is an internal wskit API — product developers use `defineModule`
 * for custom primitives. `definePrimitive` is for the primitives that
 * ship with wskit itself (ack, incoming, channel, etc.).
 *
 * The returned factory function:
 * 1. When **called** — produces a `Primitive` instance with base fields
 *    merged together with the custom `TData` fields from `create()`.
 * 2. When **used as a ref** — acts as a `PrimitiveRef` so other primitives
 *    can declare it as a dependency.
 *
 * ```ts
 * const ACK_KEY = Symbol('ack');
 *
 * const ack = definePrimitive({
 *   tag: 'ack',
 *   key: ACK_KEY,
 *   kind: 'infrastructure',
 *   create() { return {}; },
 *   setup(engine) {
 *     engine.onIncoming((msg) => { ... });
 *     engine.extendContext((ctx) => ({
 *       ack() { engine.rawSend(ctx.id, '_ack', { _ackId: ... }); }
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

    return {
      __wskit: config.tag,
      __kind: config.kind,
      __identity: identity,
      __requires: requires,
      __setup: config.setup ? (engine: EngineAccess) => config.setup!(engine, data) : undefined,
      ...data,
    } as Primitive<TTag> & TData;
  }

  factory.__key = config.key;
  return factory as PrimitiveFactory<TTag, TArgs, TData>;
}
