/* oxlint-disable @typescript-eslint/no-explicit-any */
import { error } from '@wskit/core';

// ---------------------------------------------------------------------------
// Re-exports from @wskit/core
// ---------------------------------------------------------------------------
//
// Everything the developer needs for the error system is available from one
// import path: `import { error, Block, Forbidden } from '@wskit/server/errors'`

export {
  error,
  WskitError,
  CloseCodes,
  Block,
  Skip,
  ValidationFailed,
  ChannelNotFound,
} from '@wskit/core';
export type { ErrorDef, ErrorDefWithFactory } from '@wskit/core';

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
 * Fired on your `onError` handler when a message deferred with `Defer(...)`
 * has been retried the maximum number of times (3) and still hasn't
 * succeeded. Use this to dead-letter the message — the detail gives you
 * the original event, payload, and retry count.
 *
 * Never sent to the client; this is a server-side signal only.
 *
 * @example
 * ```ts
 * .onError((ctx, err, event) => {
 *   if (DeferExhausted.matches(err)) {
 *     deadLetter.push({ event: err.detail.event, payload: err.detail.payload });
 *   }
 * })
 * ```
 */
export const DeferExhausted = error('defer-exhausted', (p: unknown) => {
  const obj = p as Record<string, unknown>;
  return {
    event: String(obj.event),
    payload: obj.payload,
    retries: Number(obj.retries),
  };
});
