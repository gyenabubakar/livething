/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */

import type { EngineAccess } from '~/_engine/access.ts';
import type * as PublicApiTypes from '~/context.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The result that `onAuthenticate` handlers can return to attach data to a
 * connection before it is accepted.
 */
export interface AuthResult {
  /**
   * Stable string identifying the user-equivalent entity behind this socket —
   * user id, session id, device id, whatever your app treats as "the same
   * client across reconnects". LiveThing does not interpret it; it stores it on
   * the connection and uses it as a row key for any per-user durable state.
   * Surfaced as `ctx.user.id` in every handler context.
   */
  readonly userId: string;
  /**
   * Arbitrary key/value data attached to every connection established from this
   * authenticate. Accessible as `ctx.meta` in all handler contexts.
   */
  readonly meta?: Record<string, unknown>;
  /**
   * Tag refs to attach to this connection. Build them with `helpers.tags`, the
   * second argument to `onAuthenticate`:
   * `tags: [helpers.tags.ephemeral('role').ref('admin')]`. Refs in the ephemeral kind
   * are accepted; refs in the persistent kind must be set at runtime via
   * `ctx.tags.persistent(group).add(key)` and are rejected here.
   */
  readonly tags?: readonly PublicApiTypes.TagRef[];
}

/** Handler type for the `onInit` key of `server({ ... })`. */
export type InitHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for the `onConnect` key of `server({ ... })`. */
export type ConnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for the `onDisconnect` key of `server({ ... })`. */
export type DisconnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for the `onPing` key of `server({ ... })`. */
export type PingHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for the `onPong` key of `server({ ... })`. */
export type PongHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/** Handler type for the `onShutdown` key of `server({ ... })`. */
export type ShutdownHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Handler type for the `onError` key of `server({ ... })`. The `event` argument is
 * the incoming event name that caused the error, when known.
 */
export type ErrorHandler<TCtx = any> = (
  ctx: TCtx,
  error: unknown,
  event?: string,
) => void | Promise<void>;

/**
 * Second argument to `onAuthenticate`. When tag groups are declared on the
 * contract, `helpers.tags` lets you attach initial tag refs to the connection
 * before it opens. `helpers.ctx` is always there.
 */
export interface AuthHelpers {
  /**
   * Storage, logger and platform for the authenticate phase. The same shape as the
   * `onInit` context: no connection exists yet, so there is no user, `meta` or
   * `send`. The app's `authenticate(request, ctx)` receives this as `ctx`. A plugin's `authenticate`
   * receives a copy scoped to the plugin, with its `kv` keys namespaced.
   */
  readonly ctx: PublicApiTypes.InitContext;
  /**
   * Tag-ref builders available during the authenticate phase. Returns a partial
   * group handle whose only method is `.ref(key)` — `add` / `remove` /
   * `has` and fan-out reads need a live connection and are not available here.
   */
  readonly tags?: {
    ephemeral(group: string): { ref(key: string): PublicApiTypes.TagRef };
    persistent(group: string): { ref(key: string): PublicApiTypes.TagRef };
  };
}

export type AuthHandler = (
  request: Request,
  helpers: AuthHelpers,
) => AuthResult | Promise<AuthResult>;

/** The TypeScript type returned by `onInit()`. */
export interface InitPrimitive<TCtx = any> extends Primitive<'on-init'> {
  readonly handler: InitHandler<TCtx>;
}

/** The TypeScript type returned by `onConnect()`. */
export interface ConnectPrimitive<TCtx = any> extends Primitive<'on-connect'> {
  readonly handler: ConnectHandler<TCtx>;
}

/** The TypeScript type returned by `onDisconnect()`. */
export interface DisconnectPrimitive<TCtx = any> extends Primitive<'on-disconnect'> {
  readonly handler: DisconnectHandler<TCtx>;
}

/** The TypeScript type returned by `onPing()`. */
export interface PingPrimitive<TCtx = any> extends Primitive<'on-ping'> {
  readonly handler: PingHandler<TCtx>;
}

/** The TypeScript type returned by `onPong()`. */
export interface PongPrimitive<TCtx = any> extends Primitive<'on-pong'> {
  readonly handler: PongHandler<TCtx>;
}

/** The TypeScript type returned by `onShutdown()`. */
export interface ShutdownPrimitive<TCtx = any> extends Primitive<'on-shutdown'> {
  readonly handler: ShutdownHandler<TCtx>;
}

/** The TypeScript type returned by `onError()`. */
export interface ErrorPrimitive<TCtx = any> extends Primitive<'on-error'> {
  readonly handler: ErrorHandler<TCtx>;
}

/** The TypeScript type returned by `onAuthenticate()`. */
export interface AuthPrimitive extends Primitive<'on-authenticate'> {
  readonly handler: AuthHandler;
}

const ON_INIT_KEY = Symbol('on-init');
const ON_CONNECT_KEY = Symbol('on-connect');
const ON_DISCONNECT_KEY = Symbol('on-disconnect');
const ON_PING_KEY = Symbol('on-ping');
const ON_PONG_KEY = Symbol('on-pong');
const ON_SHUTDOWN_KEY = Symbol('on-shutdown');
const ON_ERROR_KEY = Symbol('on-error');
const ON_AUTHENTICATE_KEY = Symbol('on-authenticate');

/** @internal */
function makeLifecycle<TTag extends string>(
  tag: TTag,
  key: symbol,
  setupFn: (engine: EngineAccess, handler: any) => void,
) {
  return <THandler>(handler: THandler) => ({
    __livething: tag,
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
    if (ctx !== undefined) await engine.runInConnectionCall(connectionId, ctx, () => handler(ctx));
  };
}

/**
 * Creates an `onInit` lifecycle primitive. Prefer the `onInit` key
 * of `server({ ... })` — this factory is used internally by `assemble(...)`.
 */
export const onInit = Object.assign(
  makeLifecycle('on-init', ON_INIT_KEY, (e, h) => e.onInit(h)) as <TCtx>(
    handler: InitHandler<TCtx>,
  ) => InitPrimitive<TCtx>,
  { __key: ON_INIT_KEY },
);

/**
 * Creates an `onConnect` lifecycle primitive. Prefer the `onConnect` key
 * of `server({ ... })` — this factory is used internally by `assemble(...)`.
 */
export const onConnect = Object.assign(
  makeLifecycle('on-connect', ON_CONNECT_KEY, (e, h) => e.onConnect(h)) as <TCtx>(
    handler: ConnectHandler<TCtx>,
  ) => ConnectPrimitive<TCtx>,
  { __key: ON_CONNECT_KEY },
);

/**
 * Creates an `onDisconnect` lifecycle primitive. Prefer the `onDisconnect` key
 * of `server({ ... })` — this factory is used internally by `assemble(...)`.
 */
export const onDisconnect = Object.assign(
  makeLifecycle('on-disconnect', ON_DISCONNECT_KEY, (e, h) => e.onDisconnect(h)) as <TCtx>(
    handler: DisconnectHandler<TCtx>,
  ) => DisconnectPrimitive<TCtx>,
  { __key: ON_DISCONNECT_KEY },
);

/**
 * Creates an `onPing` lifecycle primitive. Prefer the `onPing` key
 * of `server({ ... })` — this factory is used internally by `assemble(...)`.
 *
 * The engine has already answered the client with `pong` by the time this runs.
 */
export const onPing = Object.assign(
  makeLifecycle('on-ping', ON_PING_KEY, (engine, handler) =>
    engine.onAppPing(intoContextHandler(engine, handler)),
  ) as <TCtx>(handler: PingHandler<TCtx>) => PingPrimitive<TCtx>,
  { __key: ON_PING_KEY },
);

/**
 * Creates an `onPong` lifecycle primitive. Prefer the `onPong` key
 * of `server({ ... })` — this factory is used internally by `assemble(...)`.
 *
 * When `keepalive()` is listed it has already recorded the round-trip by the
 * time this runs, so `ctx.latency` reflects the pong that triggered it.
 */
export const onPong = Object.assign(
  makeLifecycle('on-pong', ON_PONG_KEY, (engine, handler) =>
    engine.onAppPong(intoContextHandler(engine, handler)),
  ) as <TCtx>(handler: PongHandler<TCtx>) => PongPrimitive<TCtx>,
  { __key: ON_PONG_KEY },
);

/**
 * Creates an `onShutdown` lifecycle primitive. Prefer the `onShutdown` key
 * of `server({ ... })` — this factory is used internally by `assemble(...)`.
 */
export const onShutdown = Object.assign(
  makeLifecycle('on-shutdown', ON_SHUTDOWN_KEY, (e, h) => e.onShutdown(h)) as <TCtx>(
    handler: ShutdownHandler<TCtx>,
  ) => ShutdownPrimitive<TCtx>,
  { __key: ON_SHUTDOWN_KEY },
);

/**
 * Creates an `onError` lifecycle primitive. Prefer the `onError` key
 * of `server({ ... })` — this factory is used internally by `assemble(...)`.
 */
export const onError = Object.assign(
  makeLifecycle('on-error', ON_ERROR_KEY, (e, h) => e.onError(h)) as <TCtx>(
    handler: ErrorHandler<TCtx>,
  ) => ErrorPrimitive<TCtx>,
  { __key: ON_ERROR_KEY },
);

/**
 * Creates an `onAuthenticate` lifecycle primitive. Prefer the `authenticate` option on
 * `server(...)` — this factory is used internally by `assemble(...)`.
 */
export const onAuthenticate = Object.assign(
  makeLifecycle('on-authenticate', ON_AUTHENTICATE_KEY, (e, h) => e.setBuilderAuthHook(h)) as (
    handler: AuthHandler,
  ) => AuthPrimitive,
  { __key: ON_AUTHENTICATE_KEY },
);
