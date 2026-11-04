/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

/**
 * Who owns a frame's event: the app itself, or one installed plugin.
 *
 * Computed from the event name — a plugin-owned event travels as
 * `__<id>::<name>`, everything else is the app's. `TId` narrows the plugin id
 * to the union of installed plugin ids so app authors get autocomplete.
 */
export type FrameOwner<TId extends string = string> =
  | { readonly kind: 'app' }
  | { readonly kind: 'plugin'; readonly id: TId };

/** The app owns hooks registered outside a plugin. */
export const APP_HOOK_OWNER: FrameOwner = { kind: 'app' };

/**
 * The shape of a message as it travels through the intercept pipeline.
 *
 * `kind`, `event`, and `routing` are read-only views of the dispatched frame.
 * `payload` is the raw, unvalidated payload — narrow it with
 * `ctx.matches(key, frame)` or `ctx.unsafeCast(key, frame)` to get a typed shape.
 *
 * The event name is locked from the moment the message hits the dispatcher —
 * an intercept cannot rewrite routing. The return value of the handler
 * replaces `payload` only.
 */
export interface InterceptFrame<TOwnerId extends string = string> {
  /** The event name exactly as it arrived from the client. */
  readonly event: string;
  /**
   * The payload value. Type is `unknown` until narrowed by `matches()` or
   * `unsafeCast()` from `@livething/server`. `matches()` also validates against
   * the declared schema; `unsafeCast()` is a type-only assertion.
   */
  readonly payload: unknown;
  /** Which primitive family handles this event, or `'unknown'` if none match. */
  readonly kind: 'incoming' | 'request' | 'stream' | 'nudge' | 'unknown';
  /** Curated routing metadata from the wire `__livething` envelope. */
  readonly routing: InterceptRouting;
  /** Whether this event is app-owned or plugin-owned, derived from its name. */
  readonly owner: FrameOwner<TOwnerId>;
  /** The size of the whole frame as it arrived, in bytes (UTF-8 for a text frame). */
  readonly size: number;
}

/**
 * Who one send was addressed to.
 *
 * - `all`: every connection on the server (`ctx.broadcast`, a top-level
 *   broadcast stream).
 * - `channel`: every member of `frame.channel`.
 * - `connection`: one connection.
 * - `user`: every connection of one user.
 * - `tag`: every connection with one tag key, or with any key of a tag group
 *   when `key` is absent.
 */
export type OutgoingTarget =
  | { readonly kind: 'all' }
  | { readonly kind: 'channel' }
  | { readonly kind: 'connection'; readonly id: string }
  | { readonly kind: 'user'; readonly id: string }
  | {
      readonly kind: 'tag';
      readonly tagKind: 'ephemeral' | 'persistent';
      readonly group: string;
      readonly key?: string;
    };

/**
 * One server→client send, as the `onOutgoing` hook sees it after the frame went
 * out. A send to many connections is one frame: every recipient got the same
 * payload and the same delivery metadata.
 */
export interface OutgoingFrame<TOwnerId extends string = string> {
  /** The event name as it was sent to the client. */
  readonly event: string;
  /**
   * The payload as it was sent. `ctx.matches()` / `ctx.unsafeCast()` take only
   * an incoming `InterceptFrame`, so check `frame.event` and narrow the payload
   * yourself.
   */
  readonly payload: unknown;
  /** Whether this event is app-owned or plugin-owned, derived from its name. */
  readonly owner: FrameOwner<TOwnerId>;
  /** The channel the frame was sent in, or `null` for a top-level frame. */
  readonly channel: { readonly name: string; readonly family: string | null } | null;
  /** Who the send was addressed to. */
  readonly target: OutgoingTarget;
  /** How many sockets the frame was written to. It can be `0`. */
  readonly recipients: number;
}

/**
 * Curated subset of the wire `__livething` envelope — the routing/correlation
 * markers safe for user code to read inside an intercept.
 */
export interface InterceptRouting {
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly streamId?: string;
  readonly channel?: string;
  /** The dynamic channel family key for a channel-scoped frame, or `null` for a static channel. */
  readonly channelFamily?: string | null;
  readonly deliverySeq?: number;
  readonly streamSeq?: number;
}

/**
 * The return type of an intercept handler.
 *
 * Return a new payload to replace the current one. Return `void` / `undefined`
 * to pass it through unchanged. The event name and routing cannot be rewritten
 * — whatever value you return becomes `frame.payload` verbatim, even if it
 * happens to be an object with its own `event` or `routing` fields.
 */
type InterceptResult = unknown | void | Promise<unknown | void>;

/**
 * Handler signature for an intercept: runs before any event is dispatched.
 * Receives the full `InterceptFrame` and can transform the payload.
 */
export type InterceptHandler<TCtx = any> = (ctx: TCtx, frame: InterceptFrame) => InterceptResult;

/** Primitive type for an intercept. */
export interface InterceptPrimitive<TCtx = any> extends Primitive<'intercept'> {
  readonly handler: InterceptHandler<TCtx>;
  /** Set by plugin namespacing when a plugin contributes this intercept; absent ⇒ app-owned. @internal */
  readonly __owner?: FrameOwner;
  /**
   * Runs when a frame arrives behind a pending subscribe, and is skipped when the
   * frame runs later. The rate limit sets this. @internal
   */
  readonly __chargedOnArrival?: boolean;
}

/**
 * Unique symbol. Intercepts use `[INTERCEPT_KEY, 'intercept']` as identity
 * (singleton per scope) so the same intercept can be registered idempotently.
 */
const INTERCEPT_KEY = Symbol('intercept');

/**
 * Creates an intercept primitive that fires before any event is dispatched.
 *
 * Receives the full `InterceptFrame` (`event`, `payload`, `kind`, `routing`)
 * and can replace the payload by returning a new value. Returning `void`
 * passes the payload through unchanged. The event name and routing cannot be
 * rewritten — whatever you return becomes the new `payload`, even if the
 * returned value has its own `event` or `routing` field.
 *
 * ### Pipeline order
 *
 * For every incoming message the engine walks this pipeline:
 *
 * 1. **Intercept** (if any) — one per scope (top-level, channel).
 * 2. **Event routing** — match the event to its handler.
 * 3. **Validation** — the handler's validator runs (if declared).
 * 4. **Handler** — `incoming` / `request` / `stream` trigger.
 *
 * ### Control-flow errors
 *
 * Intercepts can throw:
 *
 * - `Block` — silently drops the message; the handler never runs and no
 *   response is sent.
 * - `Disconnect(code, reason)` — closes the connection.
 *
 * @example
 * ```ts
 * import { matches } from '@livething/server';
 *
 * // Log all messages
 * intercept((ctx, frame) => { console.log(frame.kind, frame.event); });
 *
 * // Narrow + transform a specific event's payload
 * intercept((ctx, frame) => {
 *   if (matches(myContract, 'send-message', frame)) {
 *     return { ...frame.payload, text: sanitise(frame.payload.text) };
 *   }
 * });
 * ```
 */
export function intercept(handler: InterceptHandler<any>): InterceptPrimitive<any> {
  return {
    __livething: 'intercept',
    __identity: [INTERCEPT_KEY, 'intercept'],
    __requires: {},
    handler,
  };
}

/**
 * Handler signature for an outgoing hook: watches each server→client send once,
 * after the frame went out. It cannot change or stop the frame. An error it
 * throws, or a promise it returns that rejects, is logged.
 *
 * `ctx` is the context of the connection whose `on`, `request` or `stream`
 * handler, intercept, or `onConnect` hook is running when the frame is sent —
 * for a broadcast from that code, the sender, not each receiver. It is
 * `undefined` in every other case, such as a send from a channel `onSubscribe`
 * hook, `onDisconnect`, `onError`, a scheduled task, `onInit`, `onShutdown`,
 * or the admin API.
 */
export type OutgoingHandler<TCtx = any> = (
  ctx: TCtx | undefined,
  frame: OutgoingFrame,
) => void | Promise<void>;

/** Primitive type for an outgoing hook. */
export interface OutgoingHookPrimitive<TCtx = any> extends Primitive<'outgoingHook'> {
  readonly handler: OutgoingHandler<TCtx>;
  /** Set by plugin namespacing when a plugin contributes this hook; absent ⇒ app-owned. @internal */
  readonly __owner?: FrameOwner;
}

/** Unique symbol. One outgoing hook per scope, mirroring `intercept`. */
const OUTGOING_HOOK_KEY = Symbol('outgoingHook');

/**
 * Creates an outgoing-hook primitive that watches every server→client send
 * once, after the frame went out. One per scope, like `intercept`.
 *
 * Its `__setup` registers the hook through the engine's `onOutgoing` seam, so
 * it joins the same outgoing pipeline plugins already feed.
 */
export function outgoingHook(handler: OutgoingHandler<any>): OutgoingHookPrimitive<any> {
  return {
    __livething: 'outgoingHook',
    __identity: [OUTGOING_HOOK_KEY, 'outgoingHook'],
    __requires: {},
    handler,
    __setup(engine) {
      engine.onOutgoing(handler, APP_HOOK_OWNER);
    },
  } as OutgoingHookPrimitive<any>;
}
