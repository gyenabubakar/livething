import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { replay } from '@wskit/server/replay';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { SendMsg, SendRoomMsg } from './events.ts';
import type { ChatMsg, RoomMsg } from './events.ts';

// Drives the replay gap / continuity signal end to end. Retention keeps only the
// single newest row per store (`maxMessages: 1`), so one message published while
// a client is offline evicts the row the client last held and bumps the eviction
// watermark above its `lastKnownSeq` — the exact condition a `__gap__` reports.
const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'chat-msg': t<ChatMsg>(),
      'room-msg': t<RoomMsg>(),
    }),
    dedup(),
    sequence({ persist: true }),
    // Default (strict) durability: each row is persisted AND pruned in onBeforeSend,
    // before the frame goes out. The e2e relies on this — once the witness SEES a
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
    ctx.send('chat-msg', msg);
    ctx.broadcast('chat-msg', msg);
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
    ctx.channel.send('room-msg', msg);
    ctx.channel.broadcast('room-msg', msg);
  },
});

export const replayGapHandler = base.assemble({
  handlers: [handleSendMsg, handleServerDrop, handleSendRoomMsg],
});

export type ReplayGapClient = InferClient<typeof replayGapHandler>;
