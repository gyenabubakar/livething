/* oxlint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Primitive kind
// ---------------------------------------------------------------------------

/**
 * The kind of a primitive. Determines how `defineServer` processes it:
 *
 * - `'handler'` — registers an event handler (`incoming`, `request`, `stream`)
 * - `'contract'` — declares types for `InferClient` (`outgoing`, `errors`)
 * - `'infrastructure'` — configures the message pipeline (`ack`, `replay`, etc.)
 * - `'lifecycle'` — hooks into connection/server lifecycle events
 * - `'scope'` — groups primitives into namespaces or channels
 * - `'module'` — user-defined primitive (works within standard interfaces)
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
 * What platform capabilities a primitive needs. The engine merges these from
 * all registered primitives and validates at startup that the adapter provides
 * everything required.
 *
 * ```ts
 * { storage: true, timers: true }
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
 * A reference to a primitive, used in dependency declarations. Each primitive
 * factory function carries a `__key` symbol that uniquely identifies it.
 *
 * Dependencies are assertions — "this primitive must be registered in
 * defineServer, or throw at build time." They don't configure anything.
 *
 * ```ts
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
 * How `defineServer` checks for duplicate registrations:
 *
 * - `[key]` — pure singleton. One instance per handler.
 * - `[key, registrationId]` — multiple allowed if registrationId differs.
 *
 * ```
 * [wskit] Duplicate registration: incoming('send-message') is registered twice.
 * ```
 */
export type PrimitiveIdentity =
  | readonly [key: symbol]
  | readonly [key: symbol, registrationId: string];

// ---------------------------------------------------------------------------
// Engine access — what the engine gives to built-in primitives
// ---------------------------------------------------------------------------

/**
 * The interface the engine exposes to built-in primitives during setup.
 * This is the "special access" that makes a primitive a primitive — modules
 * don't get this, they get the restricted `ModuleHooks` interface instead.
 *
 * Primitives use this to wire into the engine's internals: register pipeline
 * hooks, extend the connection context, access the connection registry, etc.
 */
export interface EngineAccess {
  /** Register a hook that runs on every incoming message (sorted by dependency order). */
  onIncoming(
    handler: (message: { event: string; payload: any }) => { event: string; payload: any } | void,
  ): void;

  /** Register a hook that runs on every outgoing message (sorted by dependency order). */
  onOutgoing(
    handler: (message: { event: string; payload: any }) => { event: string; payload: any } | void,
  ): void;

  /** Register a hook that runs when a connection is established. */
  onConnect(handler: (connectionId: string) => void | Promise<void>): void;

  /** Register a hook that runs when a connection closes. */
  onDisconnect(handler: (connectionId: string) => void | Promise<void>): void;

  /** Register a hook that runs during graceful shutdown. */
  onShutdown(handler: () => void | Promise<void>): void;

  /**
   * Extend the ConnectionContext with additional methods. The factory is
   * called for each connection, receiving the base context and returning
   * the methods to add.
   *
   * This is how `ack` adds `ctx.ack()` and `replay` adds `ctx.sendReplay()`.
   */
  extendContext(factory: (baseCtx: any) => Record<string, unknown>): void;

  /** Generate a unique ID, optionally prefixed. Monotonic counter shared across the engine. */
  generateId(prefix?: string): string;

  /**
   * Send a raw message to a specific connection, bypassing the outgoing
   * pipeline. Used by primitives that send protocol messages (_ack, _replay, etc.).
   */
  rawSend(connectionId: string, event: string, payload: any): void;
}

// ---------------------------------------------------------------------------
// Primitive instance — what factory functions return
// ---------------------------------------------------------------------------

/**
 * Base interface for all primitive instances. Every factory function
 * (`incoming()`, `ack()`, `channel()`, etc.) returns an object extending this.
 *
 * `defineServer` reads the base fields to collect, validate, sort, and freeze.
 * The engine later calls `__setup` with engine access to wire the primitive
 * into the runtime pipeline.
 */
export interface Primitive<Tag extends string = string> {
  readonly __wskit: Tag;
  readonly __kind: PrimitiveKind;
  readonly __identity: PrimitiveIdentity;
  readonly __dependencies: readonly PrimitiveRef[];
  readonly __requires: RequiresManifest;

  /**
   * Called by the engine during initialization. Receives direct engine access —
   * the primitive uses this to register hooks, extend ctx, and wire into
   * the pipeline. Modules don't get this — they get `ModuleHooks` instead.
   */
  readonly __setup?: (engine: EngineAccess) => void;
}

// ---------------------------------------------------------------------------
// definePrimitive — create a built-in primitive factory
// ---------------------------------------------------------------------------

/**
 * Configuration for `definePrimitive`. Describes how a primitive factory
 * behaves — what tag it produces, whether it's singleton or repeatable,
 * what it needs from the platform, and how it wires into the engine.
 *
 * `TTag` — the discriminator tag (e.g. `'ack'`, `'incoming'`)
 * `TArgs` — the arguments the factory function accepts from the developer
 * `TData` — additional data the primitive instance carries (event name, handler, etc.)
 */
export interface PrimitiveConfig<
  TTag extends string,
  TArgs extends readonly any[],
  TData extends Record<string, any>,
> {
  readonly tag: TTag;
  readonly key: symbol;
  readonly kind: PrimitiveKind;
  readonly registrationId?: (...args: TArgs) => string;
  readonly dependencies?: readonly PrimitiveRef[];
  readonly requires?: RequiresManifest;

  /** Transform factory arguments into the data stored on the primitive instance. */
  create(...args: TArgs): TData;

  /**
   * Wire this primitive into the engine. Called once during engine initialization.
   * `data` is the output of `create()` — the developer's arguments, transformed.
   *
   * Built-in primitives get full `EngineAccess`. This is the key difference
   * from modules, which only get `ModuleHooks` (a restricted subset).
   */
  setup?(engine: EngineAccess, data: TData): void;
}

/**
 * The return type of `definePrimitive` — a factory function that also
 * serves as a `PrimitiveRef` for dependency declarations.
 *
 * ```ts
 * const ack = definePrimitive({ ... });
 *
 * // As a factory — creates a primitive instance:
 * defineServer(ack())
 *
 * // As a dependency ref — declares "I need ack":
 * defineModule({ dependencies: [ack] })
 * ```
 */
export interface PrimitiveFactory<
  TTag extends string,
  TArgs extends readonly any[],
  TData extends Record<string, any>,
> extends PrimitiveRef {
  (...args: TArgs): Primitive<TTag> & TData;
}

/**
 * Define a built-in primitive. Returns a factory function that:
 * 1. When **called** — creates a primitive instance with base fields + custom data
 * 2. When **referenced** — acts as a `PrimitiveRef` for dependency declarations
 *
 * This is internal to wskit — product developers don't call this.
 * They use `defineModule` for custom primitives.
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

    return {
      __wskit: config.tag,
      __kind: config.kind,
      __identity: identity,
      __dependencies: config.dependencies ?? [],
      __requires: config.requires ?? {},
      __setup: config.setup ? (engine: EngineAccess) => config.setup!(engine, data) : undefined,
      ...data,
    } as Primitive<TTag> & TData;
  }

  factory.__key = config.key;
  return factory as PrimitiveFactory<TTag, TArgs, TData>;
}
