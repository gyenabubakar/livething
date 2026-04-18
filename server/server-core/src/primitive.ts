/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EngineAccess } from './_engine/access.ts';

// ---------------------------------------------------------------------------
// Primitive kind
// ---------------------------------------------------------------------------

/**
 * The kind (category) of a primitive. The builder and `defineServer` use this
 * to decide how each primitive is collected and wired into the engine.
 *
 * - `'handler'`        — registers an event handler (`incoming`, `request`, `stream`)
 * - `'contract'`       — declares types for `InferClient` (`outgoing`, `errors`)
 * - `'infrastructure'` — configures the message pipeline (`ack`, `replay`, etc.)
 * - `'lifecycle'`      — hooks into connection/server lifecycle events
 * - `'scope'`          — groups primitives into namespaces or channels
 * - `'module'`         — user-defined primitive (works within standard interfaces)
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
 * Declares which platform capabilities a primitive needs at runtime.
 *
 * The engine collects these from every registered primitive and validates
 * at startup that the adapter provides everything required. If a capability
 * is missing, the engine throws with a clear error before any connection
 * is accepted.
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

// ---------------------------------------------------------------------------
// Dependency references
// ---------------------------------------------------------------------------

/**
 * A reference to a primitive factory, used to declare that another primitive
 * must be registered alongside this one.
 *
 * Each primitive factory carries a `__key` symbol. When you list another
 * factory in `dependencies`, `defineServer` checks at build time that the
 * referenced primitive was actually registered. If it was not, it throws
 * immediately — no runtime surprises.
 *
 * Dependencies are assertions only — they do not configure anything.
 *
 * ```ts
 * // "This module requires both ack and replay to be registered":
 * dependencies: [ack, replay]
 * ```
 */
export interface PrimitiveRef {
  readonly __key: symbol;
}

// ---------------------------------------------------------------------------
// Identity — singleton enforcement
// ---------------------------------------------------------------------------

/**
 * Describes how `defineServer` detects duplicate registrations.
 *
 * - `[key]` — pure singleton. Only one instance of this primitive is allowed
 *   per server handler. Registering `ack()` twice, for example, throws:
 *   `[wskit] Duplicate registration: ack is registered twice.`
 *
 * - `[key, registrationId]` — allows multiple instances as long as each has a
 *   unique `registrationId`. `incoming('send-message')` and
 *   `incoming('join-room')` are both `incoming` but have different IDs, so
 *   they are both allowed.
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
 * You rarely need to reference this type directly. Use it to annotate a
 * variable or function parameter that must accept any wskit primitive.
 *
 * `Tag` is a discriminator string (e.g. `'ack'`, `'incoming'`, `'channel'`)
 * that lets you narrow a union of primitives with `if (p.__wskit === 'ack')`.
 */
export interface Primitive<Tag extends string = string> {
  readonly __wskit: Tag;
  readonly __kind: PrimitiveKind;
  readonly __identity: PrimitiveIdentity;
  readonly __dependencies: readonly PrimitiveRef[];
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

  readonly dependencies?: readonly PrimitiveRef[];

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
      __dependencies: config.dependencies ?? [],
      __requires: requires,
      __setup: config.setup ? (engine: EngineAccess) => config.setup!(engine, data) : undefined,
      ...data,
    } as Primitive<TTag> & TData;
  }

  factory.__key = config.key;
  return factory as PrimitiveFactory<TTag, TArgs, TData>;
}
