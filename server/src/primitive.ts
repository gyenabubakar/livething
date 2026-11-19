import type { EngineAccess } from './_engine/access.ts';

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
  /** The adapter's receive limit, in bytes. */
  readonly receiveBytes: number;
  /** The channel key this primitive is scoped to, if any. */
  readonly channelKey?: string;
  /** Whether the named channel keeps its membership durable. */
  isChannelDurable(channelKey: string): boolean;
  /** Whether the named channel sends presence (its `presence` option is not `false`). */
  hasPresence(channelKey: string): boolean;
}

/**
 * The identity descriptor for a primitive. Set automatically by each primitive
 * factory — you do not interact with this directly.
 */
type PrimitiveIdentity = readonly [key: symbol] | readonly [key: symbol, registrationId: string];

/**
 * Base type for every primitive. Every primitive factory (a capability like
 * `clientRequests()` / `serverRequests()`, or an internal builder behind `base.on(...)` / `base.channel(...)`)
 * returns an object that extends `Primitive`.
 *
 * You rarely need to reference this type directly — use it to annotate a
 * variable or function parameter that must accept any LiveThing primitive.
 */
export interface Primitive<Tag extends string = string> {
  readonly __livething: Tag;
  readonly __identity: PrimitiveIdentity;
  readonly __requires: RequiresManifest;
  /**
   * Capability identity tokens (see `CAPABILITY_KIND`) this primitive needs
   * listed in the same `server({ capabilities })`. Resolved at `assemble()`:
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
interface PrimitiveConfig<TTag extends string> {
  readonly tag: TTag;
  readonly key: symbol;

  /**
   * Wire this primitive into the engine. Called once during engine
   * initialization, after all primitives have been collected.
   */
  setup(engine: EngineAccess): void;
}

/**
 * Create a factory for a built-in singleton primitive whose only job is to wire
 * runtime into the engine on setup.
 *
 * ```ts
 * const PING_KEY = Symbol('ping');
 *
 * const ping = definePrimitive({
 *   tag: 'ping',
 *   key: PING_KEY,
 *   setup(engine) {
 *     engine.extendContext((ctx) => ({
 *       ping() { engine.rawSend(ctx.connection.id, '__ping__', {}); }
 *     }));
 *   },
 * });
 * ```
 */
export function definePrimitive<TTag extends string>(
  config: PrimitiveConfig<TTag>,
): () => Primitive<TTag> {
  return () => ({
    __livething: config.tag,
    __identity: [config.key],
    __requires: {},
    __setup: config.setup,
  });
}
