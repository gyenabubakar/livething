/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

/**
 * The shape of a message as it travels through the intercept pipeline.
 *
 * `kind`, `event`, and `routing` are read-only views of the dispatched frame.
 * `payload` is the raw, unvalidated payload — narrow it with
 * `matches(contract, ...)` or `unsafeCast(contract, ...)` from `@wskit/server` to get a typed shape.
 *
 * The event name is locked from the moment the message hits the dispatcher —
 * an intercept cannot rewrite routing. The return value of the handler
 * replaces `payload` only.
 */
export interface InterceptFrame {
  /** The event name exactly as it arrived from the client. */
  readonly event: string;
  /**
   * The payload value. Type is `unknown` until narrowed by `matches()` or
   * `unsafeCast()` from `@wskit/server`. `matches()` also validates against
   * the declared schema; `unsafeCast()` is a type-only assertion.
   */
  readonly payload: unknown;
  /** Which primitive family handles this event, or `'unknown'` if none match. */
  readonly kind: 'incoming' | 'request' | 'stream' | 'nudge' | 'unknown';
  /** Curated routing metadata from the wire `__wskit` envelope. */
  readonly routing: InterceptRouting;
}

/**
 * Curated subset of the wire `__wskit` envelope — the routing/correlation
 * markers safe for user code to read inside an intercept.
 */
export interface InterceptRouting {
  readonly messageId?: string;
  readonly ackId?: string;
  readonly correlationId?: string;
  readonly streamId?: string;
  readonly channel?: string;
  readonly channelScope?: string | null;
  readonly namespace?: string;
  readonly seq?: number;
}

/**
 * The return type of an intercept handler.
 *
 * Return a new payload to replace the current one. Return `void` / `undefined`
 * to pass it through unchanged. The event name and routing cannot be rewritten
 * — whatever value you return becomes `frame.payload` verbatim, even if it
 * happens to be an object with its own `event` or `routing` fields.
 */
export type InterceptResult = unknown | void | Promise<unknown | void>;

/**
 * Handler signature for an intercept: runs before any event is dispatched.
 * Receives the full `InterceptFrame` and can transform the payload.
 */
export type InterceptHandler<TCtx = any> = (ctx: TCtx, frame: InterceptFrame) => InterceptResult;

/** Primitive type for an intercept. */
export interface InterceptPrimitive<TCtx = any> extends Primitive<'intercept'> {
  readonly handler: InterceptHandler<TCtx>;
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
 * 1. **Intercept** (if any) — one per scope (top-level, namespace, channel).
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
 * import { matches } from '@wskit/server';
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
    __wskit: 'intercept',
    __kind: 'infrastructure',
    __identity: [INTERCEPT_KEY, 'intercept'],
    __requires: {},
    handler,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
intercept.__key = INTERCEPT_KEY;
