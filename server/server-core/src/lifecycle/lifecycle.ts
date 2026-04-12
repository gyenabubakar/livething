/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */

/**
 * This file is the source of truth for all server and connection lifecycle
 * primitives. It defines the handler types, the primitive interfaces, and the
 * factory functions for all eight lifecycle hooks:
 *
 *   - `onInit`           — server has started
 *   - `onConnect`        — a client connected
 *   - `onDisconnect`     — a client disconnected
 *   - `onShutdown`       — server is shutting down
 *   - `onError`          — an unhandled error occurred
 *   - `onUpgrade`        — validate the HTTP upgrade request
 *   - `onBinary`         — a raw binary WebSocket frame arrived
 *   - `onValidationError`— a message failed schema validation
 *
 * All eight factories are created from the private `makeLifecycle` helper, which
 * produces the correct `Primitive` shape. The factories are exported with a
 * `__key` symbol so other modules can reference them in dependency declarations.
 *
 */

import type { EngineAccess } from '~/_engine/access.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The result that `onUpgrade` handlers can return to attach data to a
 * connection before it is accepted.
 */
export interface UpgradeResult {
  /**
   * Arbitrary key/value data attached to every connection established from this
   * upgrade. Accessible as `ctx.meta` in all handler contexts.
   */
  readonly meta?: Record<string, unknown>;
  /**
   * Routing tags attached to the connection. Used internally by the engine for
   * channel and namespace routing.
   */
  readonly tags?: readonly string[];
}

/**
 * Callback for `.onInit()` — runs once during `engine.initialize()`, before
 * any connections are accepted. Receives `InitContext` (storage, env, log).
 */
export type InitHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Callback for `.onConnect()` — runs after a WebSocket connection is accepted.
 * Receives full `ConnectionContext`.
 */
export type ConnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Callback for `.onDisconnect()` — runs after a connection closes. Receives
 * full `ConnectionContext` for last-moment cleanup.
 */
export type DisconnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Callback for `.onShutdown()` — runs during graceful engine shutdown.
 * Receives `ShutdownContext` (broadcast, storage, connection info — but no
 * per-connection `send`).
 */
export type ShutdownHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Callback for `.onError()` — observes unrecognized runtime errors. Does not
 * suppress the `{ code: 'internal-error' }` response sent to the client.
 *
 * `event` is the incoming event name that triggered the error, when known.
 */
export type ErrorHandler<TCtx = any> = (
  ctx: TCtx,
  error: unknown,
  event?: string,
) => void | Promise<void>;

/**
 * Callback for `.onUpgrade()` — runs before the WebSocket handshake completes.
 * Return `{ meta }` to accept and populate `ctx.meta`, or throw
 * `RejectUpgrade(code, reason)` to reject.
 */
export type UpgradeHandler = (request: Request) => UpgradeResult | Promise<UpgradeResult>;

/**
 * Callback for `.onBinary()` — handles raw binary WebSocket frames that
 * bypass the JSON pipeline entirely.
 */
export type BinaryHandler<TCtx = any> = (ctx: TCtx, data: ArrayBuffer) => void | Promise<void>;

/**
 * Callback for `.onValidationError()` — fires when an incoming payload fails
 * schema validation. By default the engine sends `ValidationFailed` to the
 * client; this hook lets you observe or log the failure.
 */
export type ValidationErrorHandler<TCtx = any> = (
  ctx: TCtx,
  event: string,
  validationError: unknown,
) => void | Promise<void>;

/**
 * Internal primitive produced by the `.onInit()` builder method.
 *
 * Collected into the server's primitive list and executed by the engine
 * during initialization.
 */
export interface InitPrimitive<TCtx = any> extends Primitive<'onInit'> {
  readonly handler: InitHandler<TCtx>;
}

/**
 * Internal primitive produced by the `.onConnect()` builder method.
 *
 * Executed by the engine each time a new WebSocket connection is accepted.
 */
export interface ConnectPrimitive<TCtx = any> extends Primitive<'onConnect'> {
  readonly handler: ConnectHandler<TCtx>;
}

/**
 * Internal primitive produced by the `.onDisconnect()` builder method.
 *
 * Executed by the engine when a connection closes.
 */
export interface DisconnectPrimitive<TCtx = any> extends Primitive<'onDisconnect'> {
  readonly handler: DisconnectHandler<TCtx>;
}

/**
 * Internal primitive produced by the `.onShutdown()` builder method.
 *
 * Executed by the engine during graceful shutdown.
 */
export interface ShutdownPrimitive<TCtx = any> extends Primitive<'onShutdown'> {
  readonly handler: ShutdownHandler<TCtx>;
}

/**
 * Internal primitive produced by the `.onError()` builder method.
 *
 * Executed by the engine when an unrecognized error is thrown in a handler.
 */
export interface ErrorPrimitive<TCtx = any> extends Primitive<'onError'> {
  readonly handler: ErrorHandler<TCtx>;
}

/**
 * Internal primitive produced by the `.onUpgrade()` builder method.
 *
 * Executed by the engine before the WebSocket handshake completes.
 */
export interface UpgradePrimitive extends Primitive<'onUpgrade'> {
  readonly handler: UpgradeHandler;
}

/**
 * Internal primitive produced by the `.onBinary()` builder method.
 *
 * Executed by the engine when a binary WebSocket frame arrives.
 */
export interface BinaryPrimitive<TCtx = any> extends Primitive<'onBinary'> {
  readonly handler: BinaryHandler<TCtx>;
}

/**
 * Internal primitive produced by the `.onValidationError()` builder method.
 *
 * Executed by the engine when an incoming payload fails schema validation.
 */
export interface ValidationErrorPrimitive<TCtx = any> extends Primitive<'onValidationError'> {
  readonly handler: ValidationErrorHandler<TCtx>;
}

const ON_INIT_KEY = Symbol('onInit');
const ON_CONNECT_KEY = Symbol('onConnect');
const ON_DISCONNECT_KEY = Symbol('onDisconnect');
const ON_SHUTDOWN_KEY = Symbol('onShutdown');
const ON_ERROR_KEY = Symbol('onError');
const ON_UPGRADE_KEY = Symbol('onUpgrade');
const ON_BINARY_KEY = Symbol('onBinary');
const ON_VALIDATION_ERROR_KEY = Symbol('onValidationError');

/**
 * Creates a lifecycle primitive factory. All eight lifecycle events have the
 * same structure — a tag, a key, and a `setup` that forwards the handler to
 * the engine — so this helper produces each one from three arguments instead
 * of writing eight separate factory functions.
 *
 * @param tag     The `__wskit` discriminator stored on the primitive.
 * @param key     Symbol used for singleton identity.
 * @param setupFn How the engine registers the handler (e.g. `e.onConnect(h)`).
 */
function makeLifecycle<TTag extends string>(
  tag: TTag,
  key: symbol,
  setupFn: (engine: EngineAccess, handler: any) => void,
) {
  return <THandler>(handler: THandler) => ({
    __wskit: tag,
    __kind: 'lifecycle' as const,
    __identity: [key] as const,
    __dependencies: [] as const,
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      setupFn(engine, handler);
    },
  });
}

/**
 * Creates an `onInit` lifecycle primitive. The handler is called once when the
 * server starts, before any WebSocket connection is accepted.
 *
 * @example
 * ```ts
 * import { onInit } from '@wskit/server/lifecycle';
 *
 * server('chat').use(onInit(async (ctx) => {
 *   await db.migrate();
 * }));
 * ```
 */
export const onInit = Object.assign(
  makeLifecycle('onInit', ON_INIT_KEY, (e, h) => e.onInit(h)) as <TCtx>(
    handler: InitHandler<TCtx>,
  ) => InitPrimitive<TCtx>,
  { __key: ON_INIT_KEY },
);

/**
 * Creates an `onConnect` lifecycle primitive. The handler is called each time
 * a client establishes a WebSocket connection.
 *
 * @example
 * ```ts
 * server('chat').use(onConnect((ctx) => {
 *   console.log('client connected', ctx.id);
 * }));
 * ```
 */
export const onConnect = Object.assign(
  makeLifecycle('onConnect', ON_CONNECT_KEY, (e, h) => e.onConnect(h)) as <TCtx>(
    handler: ConnectHandler<TCtx>,
  ) => ConnectPrimitive<TCtx>,
  { __key: ON_CONNECT_KEY },
);

/**
 * Creates an `onDisconnect` lifecycle primitive. The handler is called each
 * time a client disconnects, whether cleanly or due to a network error.
 */
export const onDisconnect = Object.assign(
  makeLifecycle('onDisconnect', ON_DISCONNECT_KEY, (e, h) => e.onDisconnect(h)) as <TCtx>(
    handler: DisconnectHandler<TCtx>,
  ) => DisconnectPrimitive<TCtx>,
  { __key: ON_DISCONNECT_KEY },
);

/**
 * Creates an `onShutdown` lifecycle primitive. The handler is called when the
 * server begins shutting down. Use this for cleanup such as flushing queues
 * or closing database connections.
 */
export const onShutdown = Object.assign(
  makeLifecycle('onShutdown', ON_SHUTDOWN_KEY, (e, h) => e.onShutdown(h)) as <TCtx>(
    handler: ShutdownHandler<TCtx>,
  ) => ShutdownPrimitive<TCtx>,
  { __key: ON_SHUTDOWN_KEY },
);

/**
 * Creates an `onError` lifecycle primitive. The handler is called when an
 * error is not caught by any other handler. Receives the handler context, the
 * error value, and — when the error occurred inside a named event handler —
 * the event name.
 */
export const onError = Object.assign(
  makeLifecycle('onError', ON_ERROR_KEY, (e, h) => e.onError(h)) as <TCtx>(
    handler: ErrorHandler<TCtx>,
  ) => ErrorPrimitive<TCtx>,
  { __key: ON_ERROR_KEY },
);

/**
 * Creates an `onUpgrade` lifecycle primitive. The handler is called when a
 * client sends the HTTP upgrade request to open a WebSocket connection.
 *
 * Return `{ meta, tags }` to attach metadata and routing tags to the
 * connection, or throw `RejectUpgrade(code, reason)` to reject it.
 *
 * @example
 * ```ts
 * server('chat').use(onUpgrade(async (req) => {
 *   const user = await auth.verify(req.headers.get('authorization'));
 *   if (!user) throw RejectUpgrade(4001, 'Unauthorized');
 *   return { meta: { userId: user.id } };
 * }));
 * ```
 */
export const onUpgrade = Object.assign(
  makeLifecycle('onUpgrade', ON_UPGRADE_KEY, (e, h) => e.onUpgrade(h)) as (
    handler: UpgradeHandler,
  ) => UpgradePrimitive,
  { __key: ON_UPGRADE_KEY },
);

/**
 * Creates an `onBinary` lifecycle primitive. The handler is called when the
 * client sends a raw binary WebSocket frame. The `data` is the raw `ArrayBuffer`
 * — wskit does not parse it.
 */
export const onBinary = Object.assign(
  makeLifecycle('onBinary', ON_BINARY_KEY, (e, h) => e.onBinary(h)) as <TCtx>(
    handler: BinaryHandler<TCtx>,
  ) => BinaryPrimitive<TCtx>,
  { __key: ON_BINARY_KEY },
);

/**
 * Creates an `onValidationError` lifecycle primitive. The handler is called
 * when an incoming message fails schema validation. Receives the handler
 * context, the event name, and the raw validation error from the schema library.
 */
export const onValidationError = Object.assign(
  makeLifecycle('onValidationError', ON_VALIDATION_ERROR_KEY, (e, h) => e.onValidationError(h)) as <
    TCtx,
  >(
    handler: ValidationErrorHandler<TCtx>,
  ) => ValidationErrorPrimitive<TCtx>,
  { __key: ON_VALIDATION_ERROR_KEY },
);
