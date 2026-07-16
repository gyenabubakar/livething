/* oxlint-disable @typescript-eslint/no-explicit-any */
import { error } from '@wskit/core';
import { assertPositiveInteger } from '~/_engine/validation.ts';
import * as v from 'valibot';

export {
  error,
  WSKitError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  InternalError,
  NudgeOverflow,
  RateLimited,
  RejoinRejected,
  RequestInvalidResponse,
  RequestNoCorrelation,
  RequestNoResponse,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
  UnsupportedProtocol,
} from '@wskit/core';
export type { ErrorDef, ErrorDefWithFactory } from '@wskit/core';

/**
 * Close the connection immediately with a close code and reason.
 *
 * Use `throw Disconnect(code, reason)` to bail out of a handler and close.
 * Use `ctx.close(code, reason)` when you need to close but continue
 * executing (e.g., logging, cleanup).
 *
 * ```ts
 * import { Disconnect, CloseCodes } from '@wskit/server/errors';
 *
 * base.on('send-message', {
 *   input: SendMessage,
 *   async run(ctx, input) {
 *     if (ctx.meta.violations > 10) throw Disconnect(CloseCodes.BANNED, 'Too many violations');
 *   },
 * });
 * ```
 */
export function Disconnect(code: number, reason: string) {
  return Object.freeze({ __wskit: 'disconnect' as const, code, reason });
}

/**
 * Reject a WebSocket upgrade request. Only valid inside the `upgrade` hook —
 * throwing it anywhere else is treated as an unrecognized error.
 *
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { RejectUpgrade } from '@wskit/server/errors';
 *
 * define({
 *   env: t<Env>(),
 *   async upgrade(req) {
 *     const user = await validateToken(req.headers.get('authorization'));
 *     if (!user) throw RejectUpgrade(4002, 'Invalid token');
 *     return { identity: user.id, meta: { userId: user.id } };
 *   },
 * });
 * ```
 */
export function RejectUpgrade(code: number, reason: string) {
  return Object.freeze({ __wskit: 'reject-upgrade' as const, code, reason });
}

/**
 * Re-enqueue the current message for processing after a delay (milliseconds).
 *
 * Valid **only in `on()` handlers**. Re-queuing replays the whole frame, which
 * only makes sense there: a `request` handler would re-run and re-answer a
 * correlation the client already settled, an intercept fires on every frame kind
 * (a request or stream frame, not just an `on()` event), and a stream generator
 * that already yielded chunks cannot restart from the top. Thrown from any of
 * those, `Defer` is treated as an unrecognized error and surfaces to the client
 * as `internal-error`.
 *
 * Up to 3 retries per message, so the handler runs **at most 4 times total**
 * (the initial attempt plus 3 retries). After the third retry still throws
 * `Defer`, the message is dropped and `onError` fires with a `DeferExhausted`
 * error whose `detail.retries` is `3`.
 *
 * ```ts
 * // pseudo-code — `tryAcquireLock` is a placeholder for your own lock helper
 * import { Defer } from '@wskit/server/errors';
 *
 * base.on('process-job', {
 *   input: ProcessJob,
 *   async run(ctx, input) {
 *     const lock = await tryAcquireLock(input.resourceId);
 *     if (!lock) throw Defer(1000); // retry in 1 second
 *   },
 * });
 * ```
 */
export function Defer(delay: number) {
  assertPositiveInteger(delay, 'delay', 'Defer()');
  return Object.freeze({ __wskit: 'defer' as const, delay });
}

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
export const DeferExhausted = error(
  'defer-exhausted',
  v.object({
    event: v.string(),
    payload: v.unknown(),
    retries: v.pipe(v.number(), v.finite()),
  }),
);
