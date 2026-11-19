/* oxlint-disable @typescript-eslint/no-explicit-any */
export {
  error,
  LiveThingError,
  CloseCodes,
  Block,
  AwarenessRefused,
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
  UploadAborted,
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
 * Reject a connection. Only valid inside the `authenticate` hook —
 * throwing it anywhere else is treated as an unrecognized error.
 *
 * ```ts
 * import { server } from '@livething/server';
 * import { RejectAuth } from '@livething/server/errors';
 *
 * server({
 *   async authenticate(req) {
 *     // The client's `token` option arrives as `Authorization: Bearer <token>`.
 *     const user = await validateToken(req.headers.get('authorization')?.slice('Bearer '.length));
 *     if (!user) throw RejectAuth(4002, 'Invalid token');
 *     return { userId: user.id, meta: { role: user.role } };
 *   },
 * });
 * ```
 */
export function RejectAuth(code: number, reason: string) {
  return Object.freeze({ __livething: 'reject-auth' as const, code, reason });
}
