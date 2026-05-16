import { event } from '@wskit/server';
import * as v from 'valibot';

export const ChatMsg = event('chat-msg', v.object({ text: v.string(), from: v.string() }));
export const SendMsg = event('send-msg', v.object({ text: v.string() }));
export const Cursor = event('cursor', v.object({ x: v.number(), y: v.number() }));
export const SendCursor = event('send-cursor', v.object({ x: v.number(), y: v.number() }));

export const RoomMsg = event('room-msg', v.object({ text: v.string(), from: v.string() }));
export const SendRoomMsg = event('send-room-msg', v.object({ text: v.string() }));
export const RequestHistory = event('request-history', v.object({}));
export const RequestRoomHistory = event('request-room-history', v.object({}));
// Top-level event that injects a family-scoped replay frame via
// ctx.sendReplay(...) with channelScope set on wire. Used to pin that
// the built-in replay forwards channelScope on top-level sends.
export const InjectFamilyReplay = event('inject-family-replay', v.object({}));
// A request-response. The handler replies with a private token via
// ctx.respond(...). Used to pin that the response is NEVER stored in replay.
export const GetToken = event('get-token', v.object({}));
export const TokenResponse = v.object({ token: v.string() });

// Triggers two failing ctx.sendReplay calls (undeclared event + reserved
// _-prefixed payload field) and reports both error messages back to the
// client. Pins that ctx.sendReplay enforces the same contract as ctx.send.
export const TriggerBadReplay = event('trigger-bad-replay', v.object({}));

// Triggers a ctx.sendReplay call whose payload carries a non-serializable
// value (BigInt). Pre-fix JSON.stringify threw out of the replay path and
// the client lost the row plus everything after it. Post-fix the row
// flips to a sanitized _error with the routing markers preserved, the
// rest of the replay loop continues, and a follow-up valid frame still
// reaches the client.
export const TriggerBigIntReplay = event('trigger-bigint-replay', v.object({}));

// Starts a one-chunk stream. The chunk frame carries `_streamId`. Pins
// that built-in replay does not persist or resend stream chunks across
// reconnects.
export const StartTinyStream = event('start-tiny-stream', v.object({}));
export const TinyChunk = v.object({ value: v.string() });
export const ReplayGuardError = event(
  'replay-guard-error',
  v.object({ undeclared: v.string(), reservedField: v.string() }),
);
