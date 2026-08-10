import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { inbox } from '@wskit/server/inbox';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { SendRoomMsg } from './events.ts';
import type { RoomMsg } from './events.ts';

// Drives inbox OVERFLOW: `chat` keeps at most one undelivered row per member
// (`retention.maxMessages: 1`). While a member is offline, a second broadcast
// evicts the first held row and lifts that member's overflow watermark. On
// reconnect, the drain emits one `__gap__` per scope before the surviving row.
// The gap only SURFACES on a client running `replay()` (which owns `__gap__` +
// `onGap`); an inbox-only client silently drops the frame — the D1 decision this
// fixture lets a spec pin down.
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [channels(), sequence({ persist: true }), dedup(), inbox()],
});

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

const chat = base.channel('chat', {
  persistent: true,
  inbox: { retention: { maxMessages: 1 } },
  outgoing: {
    emits: {
      'room-msg': t<RoomMsg>(),
    },
  },
});

export const handleSendRoomMsg = chat.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    ctx.channel.broadcast('room-msg', { text: payload.text, from: ctx.meta.username });
  },
});

// `chat` carries the `inbox: true` client-contract flag, so it is passed to
// `assemble` for `InferClient` to expose the inbox surface (receivers/receiversOf).
export const inboxGapHandler = base.assemble({
  handlers: [handleServerDrop, handleSendRoomMsg, chat],
});

export type InboxGapClient = InferClient<typeof inboxGapHandler>;
