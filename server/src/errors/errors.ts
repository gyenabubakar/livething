/* oxlint-disable @typescript-eslint/no-explicit-any */
export {
  error,
  LiveThingError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  CrossInstanceRef,
  DurableStreamRequiresUser,
  InternalError,
  NotAMember,
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
  WrongFrameKind,
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
