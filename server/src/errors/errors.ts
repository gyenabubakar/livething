/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertPositiveInteger } from '~/_engine/validation.ts';

export {
  error,
  LiveThingError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  CrossInstanceRef,
  DeferExhausted,
  DurableStreamRequiresUser,
  InternalError,
  NudgeOverflow,
  RateLimited,
  ConnectionBusy,
  RejoinRejected,
  RequestInvalidResponse,
  RequestNoCorrelation,
  RequestNoResponse,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
  UnsupportedProtocol,
} from '@livething/core';
export type { ErrorDef, ErrorDefWithFactory } from '@livething/core';

/**
 * Close the connection immediately with a close code and reason.
 *
 * Use `throw Disconnect(code, reason)` to bail out of a handler and close.
 * Use `ctx.close(code, reason)` when you need to close but continue
 * executing (e.g., logging, cleanup).
 *
 * ```ts
 * import { Disconnect, CloseCodes } from '@livething/server/errors';
 *
 * const handleSend = base.on('send-message', {
 *   input: SendMessage,
 *   async run(ctx, input) {
 *     if (ctx.meta.violations > 10) throw Disconnect(CloseCodes.BANNED, 'Too many violations');
 *   },
 * });
 * base.assemble({ handlers: [handleSend] });
 * ```
 */
export function Disconnect(code: number, reason: string) {
  return Object.freeze({ __livething: 'disconnect' as const, code, reason });
}

/**
 * Reject a WebSocket upgrade request. Only valid inside the `upgrade` hook —
 * throwing it anywhere else is treated as an unrecognized error.
 *
 * ```ts
 * import { server } from '@livething/server';
 * import { RejectUpgrade } from '@livething/server/errors';
 *
 * server({
 *   async upgrade(req) {
 *     // Browsers cannot set headers on a WebSocket handshake, so the token comes in the URL.
 *     const user = await validateToken(new URL(req.url).searchParams.get('token'));
 *     if (!user) throw RejectUpgrade(4002, 'Invalid token');
 *     return { userId: user.id, meta: { role: user.role } };
 *   },
 * });
 * ```
 */
export function RejectUpgrade(code: number, reason: string) {
  return Object.freeze({ __livething: 'reject-upgrade' as const, code, reason });
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
 * import { Defer } from '@livething/server/errors';
 *
 * const handleProcessJob = base.on('process-job', {
 *   input: ProcessJob,
 *   async run(ctx, input) {
 *     const lock = await tryAcquireLock(input.resourceId);
 *     if (!lock) throw Defer(1000); // retry in 1 second
 *   },
 * });
 * base.assemble({ handlers: [handleProcessJob] });
 * ```
 */
export function Defer(delay: number) {
  assertPositiveInteger(delay, 'delay', 'Defer()');
  return Object.freeze({ __livething: 'defer' as const, delay });
}
