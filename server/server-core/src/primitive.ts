/* oxlint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Primitive kind
// ---------------------------------------------------------------------------

/**
 * The kind of a primitive. Determines how `defineServer` processes it:
 *
 * - `'handler'` — registers an event handler (`incoming`, `request`, `stream`)
 * - `'contract'` — declares types for `InferClientType` (`outgoing`, `errors`)
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
 * // A primitive that needs persistent storage and timers:
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
 * Dependencies are assertions — they say "this primitive must be registered
 * in defineServer, or throw at build time." They don't configure anything.
 *
 * ```ts
 * // Inside a module or primitive definition:
 * dependencies: [ack, replay]
 * // means: "I need ack and replay to be registered. Fail fast if they're not."
 * ```
 */
export interface PrimitiveRef {
  readonly __key: symbol;
}

// ---------------------------------------------------------------------------
// Identity — singleton enforcement
// ---------------------------------------------------------------------------

/**
 * How `defineServer` checks for duplicate registrations. Each primitive
 * computes its identity at build time:
 *
 * - `[key]` — pure singleton. Only one instance allowed per handler.
 *   Used by infrastructure primitives (`ack`, `replay`, `heartbeat`, etc.)
 *   and lifecycle hooks (`onConnect`, `onShutdown`, etc.).
 *
 * - `[key, registrationId]` — multiple instances allowed if their
 *   `registrationId` differs. Used by handler primitives (keyed by event
 *   name), scope primitives (keyed by pattern), and modules (keyed by id).
 *
 * Duplicate identities throw immediately in `defineServer`:
 * ```
 * [wskit] Duplicate registration: incoming('send-message') is registered twice.
 * ```
 */
export type PrimitiveIdentity =
  | readonly [key: symbol]
  | readonly [key: symbol, registrationId: string];

// ---------------------------------------------------------------------------
// Primitive base
// ---------------------------------------------------------------------------

/**
 * Base interface for all primitives. Every factory function (`incoming()`,
 * `ack()`, `channel()`, modules, etc.) returns an object extending this.
 *
 * `defineServer` reads these fields to:
 * 1. Discriminate the primitive type (`__wskit` tag)
 * 2. Check for duplicate registrations (`__identity`)
 * 3. Topologically sort by dependencies (`__dependencies`)
 * 4. Validate platform capabilities (`__requires`)
 *
 * Type parameter `Tag` is a string literal (e.g. `'incoming'`, `'ack'`)
 * used as a discriminated union tag.
 */
export interface Primitive<Tag extends string = string> {
  /** Discriminator tag — identifies what kind of primitive this is. */
  readonly __wskit: Tag;

  /** Which category this primitive belongs to. */
  readonly __kind: PrimitiveKind;

  /**
   * Compound identity for singleton enforcement.
   * `[key]` for singletons, `[key, registrationId]` for repeatables.
   */
  readonly __identity: PrimitiveIdentity;

  /**
   * Other primitives that must be registered in `defineServer`.
   * Empty array if no dependencies. The engine throws at build time
   * if any dependency is missing — dependencies are never auto-included.
   */
  readonly __dependencies: readonly PrimitiveRef[];

  /**
   * Platform capabilities this primitive needs. The engine merges these
   * from all primitives and validates at startup.
   */
  readonly __requires: RequiresManifest;
}

// ---------------------------------------------------------------------------
// definePrimitive — internal helper for building primitive factories
// ---------------------------------------------------------------------------

/**
 * Configuration for defining a primitive factory. Used internally by
 * wskit to create the built-in primitive functions (`incoming`, `ack`, etc.).
 *
 * - `key` — unique Symbol identifying this primitive type
 * - `kind` — which category (`handler`, `infrastructure`, etc.)
 * - `registrationId` — optional function that derives the registration ID
 *   from the factory arguments. If omitted, the primitive is a singleton.
 */
export interface PrimitiveDefinition<TTag extends string, TArgs extends readonly any[]> {
  readonly tag: TTag;
  readonly key: symbol;
  readonly kind: PrimitiveKind;
  readonly registrationId?: (...args: TArgs) => string;
  readonly dependencies?: readonly PrimitiveRef[];
  readonly requires?: RequiresManifest;
}

/**
 * Create the identity, dependencies, and requires fields for a primitive
 * instance. Called by each primitive factory to build the base fields
 * that `defineServer` reads.
 *
 * ```ts
 * // Inside a primitive factory implementation:
 * const ACK_KEY = Symbol('ack');
 *
 * const ACK_DEF: PrimitiveDefinition<'ack', []> = {
 *   tag: 'ack',
 *   key: ACK_KEY,
 *   kind: 'infrastructure',
 * };
 *
 * function ack(): AckPrimitive {
 *   return { ...createPrimitiveBase(ACK_DEF) };
 * }
 * ```
 */
export function createPrimitiveBase<TTag extends string, TArgs extends readonly any[]>(
  def: PrimitiveDefinition<TTag, TArgs>,
  ...args: TArgs
): Pick<Primitive<TTag>, '__wskit' | '__kind' | '__identity' | '__dependencies' | '__requires'> {
  const identity: PrimitiveIdentity = def.registrationId
    ? [def.key, def.registrationId(...args)]
    : [def.key];

  return {
    __wskit: def.tag,
    __kind: def.kind,
    __identity: identity,
    __dependencies: def.dependencies ?? [],
    __requires: def.requires ?? {},
  };
}
