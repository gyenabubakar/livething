/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

/**
 * The shape of a message as it travels through the pre-intercept pipeline.
 * Interceptors receive and return this object to transform or inspect messages.
 */
export interface InterceptMessage {
  /** The event name exactly as it arrived from the client. */
  readonly event: string;
  /** The raw unparsed payload. */
  readonly payload: unknown;
}

/**
 * The return type of a pre-intercept handler.
 * Return a new `InterceptMessage` to transform the message, or return `void` /
 * `undefined` to pass it through unchanged.
 */
export type PreInterceptResult = InterceptMessage | void | Promise<InterceptMessage | void>;

/**
 * The return type of a post-intercept handler.
 * Return a new payload to replace the current one, or return `void` / `undefined`
 * to pass it through unchanged.
 */
export type PostInterceptResult<TPayload> = TPayload | void | Promise<TPayload | void>;

/**
 * Handler signature for a pre-intercept: runs before any event is dispatched.
 * Receives the full `{ event, payload }` message and can transform it.
 */
export type PreInterceptHandler<TCtx = any> = (
  ctx: TCtx,
  message: InterceptMessage,
) => PreInterceptResult;

/**
 * Handler signature for a post-intercept: runs for one specific event after
 * dispatch but before the application handler is called.
 * Receives the current payload and can transform it.
 */
export type PostInterceptHandler<TCtx = any, TPayload = unknown> = (
  ctx: TCtx,
  payload: TPayload,
) => PostInterceptResult<TPayload>;

/** Primitive type for a pre-intercept (no event filter). */
export interface PreInterceptPrimitive<TCtx = any> extends Primitive<'intercept'> {
  readonly mode: 'pre';
  readonly handler: PreInterceptHandler<TCtx>;
}

/** Primitive type for a post-intercept (scoped to one event). */
export interface PostInterceptPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TCtx = any,
> extends Primitive<'intercept'> {
  readonly mode: 'post';
  /** The event this interceptor is scoped to. */
  readonly event: TEvent;
  readonly handler: PostInterceptHandler<TCtx, TPayload>;
}

/** Union of both intercept primitive types. */
export type InterceptPrimitive<TEvent extends string = string, TPayload = unknown, TCtx = any> =
  | PreInterceptPrimitive<TCtx>
  | PostInterceptPrimitive<TEvent, TPayload, TCtx>;

/**
 * Unique symbol.
 * Pre-intercepts use `[INTERCEPT_KEY, 'pre']` as identity (singleton per scope).
 * Post-intercepts use `[INTERCEPT_KEY, 'post:<event>']` so each event can have
 * its own post-interceptor.
 */
const INTERCEPT_KEY = Symbol('intercept');

/** Overload: creates a pre-intercept that applies to every incoming message. */
export function intercept(handler: PreInterceptHandler<any>): PreInterceptPrimitive<any>;
/** Overload: creates a post-intercept scoped to `event`. */
export function intercept<TEvent extends string>(
  event: TEvent,
  handler: PostInterceptHandler<any, any>,
): PostInterceptPrimitive<TEvent, any, any>;
/**
 * Creates an intercept primitive in one of two modes:
 *
 * - **Pre-intercept** (`firstArg` is a function): fires before the event is
 *   dispatched. Receives the raw `{ event, payload }` and can replace it.
 *   Returning `void` passes the message through unchanged.
 *
 * - **Post-intercept** (`firstArg` is a string): fires for a single named
 *   event, after the event is matched but before the handler runs. Receives
 *   the current payload and can replace it. Returning `void` passes the payload
 *   through unchanged.
 *
 * Post-intercepts only run when a matching `incoming`, `request`, or `stream`
 * handler is registered for that event in the same scope. If none exists, the
 * engine throws at boot.
 *
 * ### Pipeline order
 *
 * For every incoming message the engine walks this pipeline:
 *
 * 1. **Pre-intercept** (if any) — one per scope (top-level, namespace, channel).
 * 2. **Event routing** — match the event to its handler.
 * 3. **Post-intercept for that event** (if any).
 * 4. **Validation** — the handler's validator runs (if declared).
 * 5. **Handler** — `incoming` / `request` / `stream` trigger.
 *
 * ### Control-flow errors
 *
 * Pre- and post-intercepts can throw:
 *
 * - `Block` — silently drops the message; the handler never runs and no
 *   response is sent.
 * - `Skip` — from a **pre**-intercept, passes the message through unchanged
 *   (identical to returning `void`). From a post-intercept it behaves the same.
 * - `Disconnect(code, reason)` — closes the connection.
 *
 * @example
 * ```ts
 * // Pre-intercept: log all messages
 * intercept((ctx, msg) => { console.log(msg.event); });
 *
 * // Post-intercept: sanitise one event's payload
 * intercept('send-message', (ctx, payload) => ({
 *   ...payload,
 *   text: sanitise(payload.text),
 * }));
 * ```
 */
export function intercept(
  firstArg: string | PreInterceptHandler<any>,
  secondArg?: PostInterceptHandler<any, any>,
): InterceptPrimitive {
  if (typeof firstArg === 'string') {
    return {
      __wskit: 'intercept',
      __kind: 'infrastructure',
      __identity: [INTERCEPT_KEY, `post:${firstArg}`],
      __dependencies: [],
      __requires: {},
      mode: 'post',
      event: firstArg,
      handler: secondArg!,
    };
  }

  return {
    __wskit: 'intercept',
    __kind: 'infrastructure',
    __identity: [INTERCEPT_KEY, 'pre'],
    __dependencies: [],
    __requires: {},
    mode: 'pre',
    handler: firstArg,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
intercept.__key = INTERCEPT_KEY;
