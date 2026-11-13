import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { Disconnect } from '@livething/server/errors';
import { keepalive } from '@livething/server/keepalive';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';
import { SendMsg, SendRoomMsg } from './events.ts';
import type { ChatMsg, RoomMsg } from './events.ts';

// Drives the replay gap / continuity signal end to end. Retention keeps only the
// single newest row per store (`maxMessages: 1`), so one message published while
// a client is offline evicts the row the client last held and bumps the eviction
// watermark above its `lastKnownSeq` — the exact condition a `__gap__` reports.
const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [
    keepalive(),
    emits({
      'chat-msg': t<ChatMsg>(),
      'room-msg': t<RoomMsg>(),
    }),
    dedup(),
    sequence({ persist: true }),
    // Default (strict) durability: each broadcast is persisted AND pruned before
    // the frame goes out. The e2e relies on this — once the witness SEES a
    // broadcast, the eviction that lifts the watermark has already committed, so the
    // subject's later reconnect deterministically observes the gap (no flake).
    replay.history({ retention: { maxMessages: 1 } }),
    channels(),
  ],
});

export const handleSendMsg = base.on('send-msg', {
  input: SendMsg,
  run(ctx, payload) {
    const msg = { text: payload.text, from: ctx.meta.username };
    ctx.broadcast('chat-msg', msg, { includeSelf: true });
  },
});

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

const gapRoom = base.channel('gap-room', {
  capabilities: [
    emits({
      'room-msg': t<RoomMsg>(),
    }),
  ],
});

export const handleSendRoomMsg = gapRoom.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    const msg = { text: payload.text, from: ctx.meta.username };
    ctx.channel.broadcast('room-msg', msg, { includeSelf: true });
  },
});

export const replayGapDefinition = base.assemble({
  handlers: [handleSendMsg, handleServerDrop, handleSendRoomMsg],
});

export type ReplayGapClient = InferClient<typeof replayGapDefinition>;
