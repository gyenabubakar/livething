/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */

import type { EngineAccess } from '~/_engine/access.ts';
import type * as PublicApiTypes from '~/context.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The result that `onUpgrade` handlers can return to attach data to a
 * connection before it is accepted.
 */
export interface UpgradeResult {
  /**
   * Stable string identifying the user-equivalent entity behind this socket —
   * user id, session id, device id, whatever your app treats as "the same
   * client across reconnects". WSKit does not interpret it; it stores it on
   * the connection and uses it as a row key for any per-user durable state.
   * Surfaced as `ctx.identity` in every handler context.
   */
  readonly identity: string;
  /**
   * Arbitrary key/value data attached to every connection established from this
   * upgrade. Accessible as `ctx.meta` in all handler contexts.
   */
  readonly meta?: Record<string, unknown>;
  /**
   * Tag refs to attach to this connection. Build them with the helper passed
   * as the second argument to `onUpgrade`:
   * `tags: [tags.ephemeral('role').ref('admin')]`. Refs in the ephemeral kind
   * are accepted; refs in the persistent kind must be set at runtime via
   * `ctx.tags.persistent(group).add(key)` and are rejected here.
   */
  readonly tags?: readonly PublicApiTypes.TagRef[];
}

/** Handler type for `base.onInit(...)`. */
export type InitHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for `base.onConnect(...)`. */
export type ConnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for `base.onDisconnect(...)`. */
export type DisconnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for `base.onPing(...)`. */
export type PingHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for `base.onPong(...)`. */
export type PongHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for `base.onShutdown(...)`. */
export type ShutdownHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Handler type for `base.onError(...)`. The `event` argument is
 * the incoming event name that caused the error, when known.
 */
export type ErrorHandler<TCtx = any> = (
  ctx: TCtx,
  error: unknown,
  event?: string,
) => void | Promise<void>;

/**
 * Second argument to `onUpgrade`. When tag groups are declared on the
 * contract, `helpers.tags` lets you attach initial tag refs to the connection
 * before it opens. Always an object (possibly empty) — safe to destructure.
 */
export interface UpgradeHelpers {
  /**
   * Tag-ref builders available during the upgrade phase. Returns a partial
   * group handle whose only method is `.ref(key)` — `add` / `remove` /
   * `has` and fan-out reads need a live connection and are not available here.
   */
  readonly tags?: {
    ephemeral(group: string): { ref(key: string): PublicApiTypes.TagRef };
    persistent(group: string): { ref(key: string): PublicApiTypes.TagRef };
  };
}

export type UpgradeHandler = (
  request: Request,
  helpers: UpgradeHelpers,
) => UpgradeResult | Promise<UpgradeResult>;

/** Handler type for `base.onValidationError(...)`. */
export type ValidationErrorHandler<TCtx = any> = (
  ctx: TCtx,
  event: string,
  validationError: unknown,
) => void | Promise<void>;

/** The TypeScript type returned by `onInit()`. */
export interface InitPrimitive<TCtx = any> extends Primitive<'onInit'> {
  readonly handler: InitHandler<TCtx>;
}

/** The TypeScript type returned by `onConnect()`. */
export interface ConnectPrimitive<TCtx = any> extends Primitive<'onConnect'> {
  readonly handler: ConnectHandler<TCtx>;
}

/** The TypeScript type returned by `onDisconnect()`. */
export interface DisconnectPrimitive<TCtx = any> extends Primitive<'onDisconnect'> {
  readonly handler: DisconnectHandler<TCtx>;
}

/** The TypeScript type returned by `onPing()`. */
export interface PingPrimitive<TCtx = any> extends Primitive<'onPing'> {
  readonly handler: PingHandler<TCtx>;
}

/** The TypeScript type returned by `onPong()`. */
export interface PongPrimitive<TCtx = any> extends Primitive<'onPong'> {
  readonly handler: PongHandler<TCtx>;
}

/** The TypeScript type returned by `onShutdown()`. */
export interface ShutdownPrimitive<TCtx = any> extends Primitive<'onShutdown'> {
  readonly handler: ShutdownHandler<TCtx>;
}

/** The TypeScript type returned by `onError()`. */
export interface ErrorPrimitive<TCtx = any> extends Primitive<'onError'> {
  readonly handler: ErrorHandler<TCtx>;
}

/** The TypeScript type returned by `onUpgrade()`. */
export interface UpgradePrimitive extends Primitive<'onUpgrade'> {
  readonly handler: UpgradeHandler;
}

/** The TypeScript type returned by `onValidationError()`. */
export interface ValidationErrorPrimitive<TCtx = any> extends Primitive<'onValidationError'> {
  readonly handler: ValidationErrorHandler<TCtx>;
}

const ON_INIT_KEY = Symbol('onInit');
const ON_CONNECT_KEY = Symbol('onConnect');
const ON_DISCONNECT_KEY = Symbol('onDisconnect');
const ON_PING_KEY = Symbol('onPing');
const ON_PONG_KEY = Symbol('onPong');
const ON_SHUTDOWN_KEY = Symbol('onShutdown');
const ON_ERROR_KEY = Symbol('onError');
const ON_UPGRADE_KEY = Symbol('onUpgrade');
const ON_VALIDATION_ERROR_KEY = Symbol('onValidationError');

/** @internal */
function makeLifecycle<TTag extends string>(
  tag: TTag,
  key: symbol,
  setupFn: (engine: EngineAccess, handler: any) => void,
) {
  return <THandler>(handler: THandler) => ({
    __wskit: tag,
    __kind: 'lifecycle' as const,
    __identity: [key] as const,
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      setupFn(engine, handler);
    },
  });
}

/**
 * Adapt an app handler that expects a `ctx` to the connection-id hook the
 * engine registers for heartbeat frames. A connection that closed between the
 * frame arriving and the hook running no longer has a context, so it is
 * skipped rather than handed a stale one.
 *
 * @internal
 */
function intoContextHandler(
  engine: EngineAccess,
  handler: (ctx: any) => void | Promise<void>,
): (connectionId: string) => Promise<void> {
  return async (connectionId) => {
    const ctx = engine.getConnectionContext(connectionId);
    if (ctx !== undefined) await handler(ctx);
  };
}

/**
 * Creates an `onInit` lifecycle primitive. Prefer `base.onInit(...)`
 * — this factory is used internally by `assemble(...)`.
 */
export const onInit = Object.assign(
  makeLifecycle('onInit', ON_INIT_KEY, (e, h) => e.onInit(h)) as <TCtx>(
    handler: InitHandler<TCtx>,
  ) => InitPrimitive<TCtx>,
  { __key: ON_INIT_KEY },
);

/**
 * Creates an `onConnect` lifecycle primitive. Prefer `base.onConnect(...)`
 * — this factory is used internally by `assemble(...)`.
 */
export const onConnect = Object.assign(
  makeLifecycle('onConnect', ON_CONNECT_KEY, (e, h) => e.onConnect(h)) as <TCtx>(
    handler: ConnectHandler<TCtx>,
  ) => ConnectPrimitive<TCtx>,
  { __key: ON_CONNECT_KEY },
);

/**
 * Creates an `onDisconnect` lifecycle primitive. Prefer `base.onDisconnect(...)`
 * — this factory is used internally by `assemble(...)`.
 */
export const onDisconnect = Object.assign(
  makeLifecycle('onDisconnect', ON_DISCONNECT_KEY, (e, h) => e.onDisconnect(h)) as <TCtx>(
    handler: DisconnectHandler<TCtx>,
  ) => DisconnectPrimitive<TCtx>,
  { __key: ON_DISCONNECT_KEY },
);

/**
 * Creates an `onPing` lifecycle primitive. Prefer `base.onPing(...)`
 * — this factory is used internally by `assemble(...)`.
 *
 * The engine has already answered the client with `pong` by the time this runs.
 */
export const onPing = Object.assign(
  makeLifecycle('onPing', ON_PING_KEY, (engine, handler) =>
    engine.onAppPing(intoContextHandler(engine, handler)),
  ) as <TCtx>(handler: PingHandler<TCtx>) => PingPrimitive<TCtx>,
  { __key: ON_PING_KEY },
);

/**
 * Creates an `onPong` lifecycle primitive. Prefer `base.onPong(...)`
 * — this factory is used internally by `assemble(...)`.
 *
 * When `keepalive()` is listed it has already recorded the round-trip by the
 * time this runs, so `ctx.latency` reflects the pong that triggered it.
 */
export const onPong = Object.assign(
  makeLifecycle('onPong', ON_PONG_KEY, (engine, handler) =>
    engine.onAppPong(intoContextHandler(engine, handler)),
  ) as <TCtx>(handler: PongHandler<TCtx>) => PongPrimitive<TCtx>,
  { __key: ON_PONG_KEY },
);

/**
 * Creates an `onShutdown` lifecycle primitive. Prefer `base.onShutdown(...)`
 * — this factory is used internally by `assemble(...)`.
 */
export const onShutdown = Object.assign(
  makeLifecycle('onShutdown', ON_SHUTDOWN_KEY, (e, h) => e.onShutdown(h)) as <TCtx>(
    handler: ShutdownHandler<TCtx>,
  ) => ShutdownPrimitive<TCtx>,
  { __key: ON_SHUTDOWN_KEY },
);

/**
 * Creates an `onError` lifecycle primitive. Prefer `base.onError(...)`
 * — this factory is used internally by `assemble(...)`.
 */
export const onError = Object.assign(
  makeLifecycle('onError', ON_ERROR_KEY, (e, h) => e.onError(h)) as <TCtx>(
    handler: ErrorHandler<TCtx>,
  ) => ErrorPrimitive<TCtx>,
  { __key: ON_ERROR_KEY },
);

/**
 * Creates an `onUpgrade` lifecycle primitive. Prefer the `upgrade` option on
 * `define(...)` — this factory is used internally by `assemble(...)`.
 */
export const onUpgrade = Object.assign(
  makeLifecycle('onUpgrade', ON_UPGRADE_KEY, (e, h) => e.setBuilderUpgradeHook(h)) as (
    handler: UpgradeHandler,
  ) => UpgradePrimitive,
  { __key: ON_UPGRADE_KEY },
);

/**
 * Creates an `onValidationError` lifecycle primitive. Prefer `base.onValidationError(...)`
 * — this factory is used internally by `assemble(...)`.
 */
export const onValidationError = Object.assign(
  makeLifecycle('onValidationError', ON_VALIDATION_ERROR_KEY, (e, h) => e.onValidationError(h)) as <
    TCtx,
  >(
    handler: ValidationErrorHandler<TCtx>,
  ) => ValidationErrorPrimitive<TCtx>,
  { __key: ON_VALIDATION_ERROR_KEY },
);
