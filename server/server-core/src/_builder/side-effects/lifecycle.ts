/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */
/**
 * Side-effect import that adds all connection and server lifecycle methods to
 * the server and group builders.
 *
 * Import path: `import '@wskit/server/lifecycle'`
 * Adds methods:
 *   - `.onInit(handler)` — server has started, before any connection
 *   - `.onConnect(handler)` — a client connected
 *   - `.onDisconnect(handler)` — a client disconnected
 *   - `.onShutdown(handler)` — server is shutting down
 *   - `.onError(handler)` — an unhandled error occurred
 *   - `.onUpgrade(handler)` — validate/annotate the HTTP upgrade request
 *   - `.onBinary(handler)` — a raw binary message arrived
 *   - `.onValidationError(handler)` — an incoming message failed schema validation
 *
 * All eight methods follow the same pattern: they take a handler function and
 * push the corresponding lifecycle primitive onto the builder's primitive list.
 * Instead of writing eight nearly-identical prototype assignments, the shared
 * `patchLifecycle` helper reduces the repetition.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about all eight methods and a `patchLifecycle` helper to register them at
 * runtime on both `ServerBuilder.prototype` and `GroupBuilder.prototype`.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import {
  onBinary as createOnBinary,
  onConnect as createOnConnect,
  onDisconnect as createOnDisconnect,
  onError as createOnError,
  onInit as createOnInit,
  onShutdown as createOnShutdown,
  onUpgrade as createOnUpgrade,
  onValidationError as createOnValidationError,
} from '~/lifecycle/lifecycle.ts';
import type { HandlerCtxFromState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { InitContext, ShutdownContext } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * Module augmentation: adds all eight lifecycle methods to `ServerBuilder` and
 * `GroupBuilder` so TypeScript recognises them after this file is imported.
 *
 * None of these methods change the builder's type-level state (`TState`).
 * Lifecycle hooks are side effects, not event declarations.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Run `handler` once when the server initialises, before any WebSocket
     * connection is accepted. Use this for one-time setup (e.g. database
     * migrations, loading config).
     */
    onInit(handler: (ctx: InitContext) => void | Promise<void>): ServerBuilder<TState>;

    /**
     * Run `handler` each time a client establishes a WebSocket connection.
     * The `ctx` has the full handler context including any metadata set by
     * `onUpgrade`.
     */
    onConnect(
      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
    ): ServerBuilder<TState>;

    /**
     * Run `handler` each time a client disconnects, whether cleanly or due to
     * a network error.
     */
    onDisconnect(
      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
    ): ServerBuilder<TState>;

    /**
     * Run `handler` when the server begins shutting down. Use this for cleanup
     * (e.g. flushing queues, closing connections gracefully).
     */
    onShutdown(handler: (ctx: ShutdownContext) => void | Promise<void>): ServerBuilder<TState>;

    /**
     * Run `handler` when an error is not caught by any other handler. Receives
     * the handler context, the error value, and — when the error occurred inside
     * a named event handler — the event name.
     */
    onError(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        error: unknown,
        event?: string,
      ) => void | Promise<void>,
    ): ServerBuilder<TState>;

    /**
     * Run `handler` when a client sends the HTTP upgrade request to open a
     * WebSocket connection. Use this to validate tokens, extract session data,
     * or reject the connection.
     *
     * Return `{ meta, tags }` to attach metadata and routing tags to the
     * connection. Throw `RejectUpgrade(code, reason)` to reject it.
     *
     * The return type's `meta` field is inferred and threaded into `ctx.meta`
     * for all subsequent handlers, giving you type-safe access to session data.
     */
    onUpgrade<TMeta extends Record<string, unknown> = Record<string, unknown>>(
      handler: (request: Request) => { meta?: TMeta; tags?: readonly string[] } | Promise<{ meta?: TMeta; tags?: readonly string[] }>,
    ): ServerBuilder<{
      readonly kind: TState['kind'];
      readonly outgoing: TState['outgoing'];
      readonly hasAck: TState['hasAck'];
      readonly hasReplay: TState['hasReplay'];
      readonly contract: TState['contract'];
      readonly errors: TState['errors'];
      readonly meta: TMeta;
      readonly channelNames: TState['channelNames'];
    }>;

    /**
     * Run `handler` when the client sends a raw binary WebSocket frame. The
     * `data` is the raw `ArrayBuffer` — wskit does not try to parse it.
     */
    onBinary(
      handler: (ctx: HandlerCtxFromState<TState>, data: ArrayBuffer) => void | Promise<void>,
    ): ServerBuilder<TState>;

    /**
     * Run `handler` when an incoming message fails schema validation. Receives
     * the handler context, the event name, and the raw validation error from
     * the schema library.
     */
    onValidationError(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        event: string,
        validationError: unknown,
      ) => void | Promise<void>,
    ): ServerBuilder<TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /** Run `handler` once on server initialisation. */
    onInit(handler: (ctx: InitContext) => void | Promise<void>): GroupBuilder<TState>;

    /** Run `handler` on each client connection. */
    onConnect(
      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
    ): GroupBuilder<TState>;

    /** Run `handler` on each client disconnection. */
    onDisconnect(
      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
    ): GroupBuilder<TState>;

    /** Run `handler` when the server shuts down. */
    onShutdown(handler: (ctx: ShutdownContext) => void | Promise<void>): GroupBuilder<TState>;

    /** Run `handler` on unhandled errors. */
    onError(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        error: unknown,
        event?: string,
      ) => void | Promise<void>,
    ): GroupBuilder<TState>;

    /** Run `handler` on the HTTP upgrade request before the WebSocket is opened. */
    onUpgrade<TMeta extends Record<string, unknown> = Record<string, unknown>>(
      handler: (request: Request) => { meta?: TMeta; tags?: readonly string[] } | Promise<{ meta?: TMeta; tags?: readonly string[] }>,
    ): GroupBuilder<{
      readonly kind: TState['kind'];
      readonly outgoing: TState['outgoing'];
      readonly hasAck: TState['hasAck'];
      readonly hasReplay: TState['hasReplay'];
      readonly contract: TState['contract'];
      readonly errors: TState['errors'];
      readonly meta: TMeta;
      readonly channelNames: TState['channelNames'];
    }>;

    /** Run `handler` when a raw binary frame arrives. */
    onBinary(
      handler: (ctx: HandlerCtxFromState<TState>, data: ArrayBuffer) => void | Promise<void>,
    ): GroupBuilder<TState>;

    /** Run `handler` when an incoming message fails schema validation. */
    onValidationError(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        event: string,
        validationError: unknown,
      ) => void | Promise<void>,
    ): GroupBuilder<TState>;
  }
}

/**
 * Adds one lifecycle method to a builder prototype.
 *
 * All eight lifecycle methods have the same shape: push a primitive built by
 * `factory(handler)` and return `this`. This helper captures that pattern so
 * we don't repeat the same three lines eight times for each of the two builder
 * prototypes.
 *
 * @param proto   The prototype object to patch (e.g. `ServerBuilder.prototype`).
 * @param name    The method name to assign (e.g. `'onConnect'`).
 * @param factory The primitive factory function (e.g. `createOnConnect`).
 */
function patchLifecycle(proto: Record<string, any>, name: string, factory: (handler: any) => any) {
  proto[name] = function (this: { _primitives: Primitive[] }, handler: any) {
    this._primitives.push(factory(handler) as unknown as Primitive);
    return this;
  };
}

patchLifecycle(ServerBuilder.prototype, 'onInit', createOnInit);
patchLifecycle(ServerBuilder.prototype, 'onConnect', createOnConnect);
patchLifecycle(ServerBuilder.prototype, 'onDisconnect', createOnDisconnect);
patchLifecycle(ServerBuilder.prototype, 'onShutdown', createOnShutdown);
patchLifecycle(ServerBuilder.prototype, 'onError', createOnError);
patchLifecycle(ServerBuilder.prototype, 'onUpgrade', createOnUpgrade);
patchLifecycle(ServerBuilder.prototype, 'onBinary', createOnBinary);
patchLifecycle(ServerBuilder.prototype, 'onValidationError', createOnValidationError);

patchLifecycle(GroupBuilder.prototype, 'onInit', createOnInit);
patchLifecycle(GroupBuilder.prototype, 'onConnect', createOnConnect);
patchLifecycle(GroupBuilder.prototype, 'onDisconnect', createOnDisconnect);
patchLifecycle(GroupBuilder.prototype, 'onShutdown', createOnShutdown);
patchLifecycle(GroupBuilder.prototype, 'onError', createOnError);
patchLifecycle(GroupBuilder.prototype, 'onUpgrade', createOnUpgrade);
patchLifecycle(GroupBuilder.prototype, 'onBinary', createOnBinary);
patchLifecycle(GroupBuilder.prototype, 'onValidationError', createOnValidationError);
