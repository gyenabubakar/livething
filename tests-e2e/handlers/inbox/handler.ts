import { define, emits, t } from '@wskit/server';
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

// Drives guaranteed per-member inbox delivery end to end. `chat` is a persistent,
// inbox-backed channel: every broadcast writes one durable row per member and
// holds it until that member acks with `__received__`. A member that is OFFLINE
// when a broadcast lands still gets the message — its rows are drained on the
// next reconnect (after the auto-rejoin), and its `__received__` ack settles them
// so a later reconnect does not re-deliver. `onDelivered: 'delete'` (the
// default) drops each row once acked.
const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [channels(), sequence({ persist: true }), dedup()],
});

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

const chat = base.channel('chat', {
  capabilities: [
    inbox(),
    emits({
      'room-msg': t<RoomMsg>(),
    }),
  ],
});

export const handleSendRoomMsg = chat.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    ctx.channel.broadcast('room-msg', { text: payload.text, from: ctx.meta.username });
  },
});

// `chat` carries the `inbox: true` client-contract flag, so it is passed to
// `assemble` for `InferClient` to expose the inbox surface (receivers/receiversOf).
export const inboxHandler = base.assemble({
  handlers: [handleServerDrop, handleSendRoomMsg, chat],
});

export type InboxClient = InferClient<typeof inboxHandler>;
