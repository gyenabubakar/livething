/* oxlint-disable @typescript-eslint/no-explicit-any */
import { error } from '@wskit/core';

// ---------------------------------------------------------------------------
// Re-exports from @wskit/core
// ---------------------------------------------------------------------------
//
// Everything the developer needs for the error system is available from one
// import path: `import { error, Block, Forbidden } from '@wskit/server/errors'`

/**
 * Create a named error definition. Pass to `.errors()` on the builder so the
 * engine knows this error exists, and use the returned factory to throw the
 * error from your handlers.
 *
 * ```ts
 * const NotFound = error('not-found', (p: { id: string }) => p);
 *
 * // In a handler:
 * throw NotFound({ id: payload.id });
 * ```
 */
export { error } from '@wskit/core';

/**
 * Base class for all wskit errors sent to clients. Errors thrown with the
 * factories created by `error()` are instances of `WskitError`. You can
 * use `instanceof WskitError` in catch blocks to detect them.
 */
export { WskitError } from '@wskit/core';

/**
 * Standard WebSocket close codes used by wskit. Use these with `Disconnect()`
 * instead of raw numbers so the intent is clear at the call site.
 */
export { CloseCodes } from '@wskit/core';

/**
 * Throw `Block` from a handler or interceptor to silently drop the message.
 * No error is sent to the client and `onError` is not called. Useful for
 * rate limiting or ignoring messages from misbehaving clients.
 */
export { Block } from '@wskit/core';

/**
 * Throw `Skip` from a pre-intercept to pass the current message through
 * to the next interceptor without any modification, bypassing any
 * transformation logic in the current interceptor.
 */
export { Skip } from '@wskit/core';

/**
 * Throw `ValidationFailed` from a handler or interceptor to trigger
 * `onValidationError` as if the schema validation itself had failed.
 * Useful when performing manual validation steps inside a handler.
 */
export { ValidationFailed } from '@wskit/core';

/**
 * TypeScript type for the object returned by `error()`. Use this when
 * you need to annotate a variable or parameter that holds an error definition.
 */
export type { ErrorDef } from '@wskit/core';

/**
 * TypeScript type for an error definition that includes a custom payload
 * factory function. Extends `ErrorDef` with the factory typing.
 */
export type { ErrorDefWithFactory } from '@wskit/core';

// ---------------------------------------------------------------------------
// Server-only control flow errors
// ---------------------------------------------------------------------------
//
// These are signals to the engine — not sent to the client. Throw them from
// handlers, intercepts, or hooks to control connection and message lifecycle.

/**
 * Close the connection immediately with a close code and reason.
 *
 * Use `throw Disconnect(code, reason)` to bail out of a handler and close.
 * Use `ctx.close(code, reason)` when you need to close but continue
 * executing (e.g., logging, cleanup).
 *
 * ```ts
 * incoming('send-message', async (ctx, payload) => {
 *   if (ctx.meta.violations > 10) throw Disconnect(CloseCodes.BANNED, 'Too many violations');
 * });
 * ```
 */
export function Disconnect(code: number, reason: string) {
  return Object.freeze({ __wskit: 'disconnect' as const, code, reason });
}

/**
 * Reject a WebSocket upgrade request. Only valid inside `onUpgrade` —
 * throwing it anywhere else is treated as an unrecognized error.
 *
 * ```ts
 * onUpgrade(async (req) => {
 *   const user = await validateToken(req.headers.get('authorization'));
 *   if (!user) throw RejectUpgrade(4002, 'Invalid token');
 *   return { meta: { userId: user.id } };
 * });
 * ```
 */
export function RejectUpgrade(code: number, reason: string) {
  return Object.freeze({ __wskit: 'reject-upgrade' as const, code, reason });
}

/**
 * Re-enqueue the current message for processing after a delay (milliseconds).
 * Only valid in `incoming` handlers and intercepts — in `request` or `stream`
 * handlers, it's treated as an unrecognized error (`internal-error`).
 *
 * Max 3 retries per message. After that, the message is dropped and `onError`
 * fires with a `DeferExhausted` error.
 *
 * ```ts
 * incoming('process-job', async (ctx, payload) => {
 *   const lock = await tryAcquireLock(payload.resourceId);
 *   if (!lock) throw Defer(1000); // retry in 1 second
 * });
 * ```
 */
export function Defer(delay: number) {
  return Object.freeze({ __wskit: 'defer' as const, delay });
}

// ---------------------------------------------------------------------------
// Server-only built-in error definitions
// ---------------------------------------------------------------------------

/**
 * Fired on the server's `onError` when a deferred message exhausts its
 * retry limit (3 attempts). Never sent to the client — it's a server-side
 * notification only. Auto-registered by the engine.
 *
 * Detail contains the original event name, the original payload (so you
 * can dead-letter it), and the retry count.
 */
export const DeferExhausted = error('defer-exhausted', (p: unknown) => {
  const obj = p as Record<string, unknown>;
  return {
    event: String(obj.event),
    payload: obj.payload,
    retries: Number(obj.retries),
  };
});
