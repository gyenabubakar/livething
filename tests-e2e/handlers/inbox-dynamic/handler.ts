import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { inbox, readReceipts } from '@wskit/server/inbox';
import { replay } from '@wskit/server/replay';
import { sequence } from '@wskit/server/sequence';
import { tags } from '@wskit/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { AddFavorite, SendRoomMsg, SendTopMsg } from './events.ts';
import type { RoomMsg, TopMsg } from './events.ts';

// Proves inbox + readReceipts on a DYNAMIC channel family, alongside a host
// that also runs replay() and tags() — neither interferes with the other.
// `rooms`/`room:{id}` is a persistent-membership dynamic family: fan-out,
// the held row, the `__received__` ack, and the drain must all key off the
// concrete (family, name) pair the member joined, not the family alone. The
// host's top-level `replay.history()` events keep their own sequence
// numbers, independent of a room's per-member inbox seq.
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    channels(),
    sequence({ persist: true }),
    dedup(),
    replay.history({ retention: { maxMessages: 100, maxAgeMs: 60_000 }, durability: 'strict' }),
    tags((_ephemeral, persistent) => [persistent('favorite', t<string>())]),
    emits({ 'top-msg': t<TopMsg>() }),
  ],
});

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

export const handleSendTopMsg = base.on('send-top-msg', {
  input: SendTopMsg,
  run(ctx, payload) {
    const msg = { text: payload.text, from: ctx.meta.username };
    ctx.send('top-msg', msg);
    ctx.broadcast('top-msg', msg);
  },
});

export const handleAddFavorite = base.on('add-favorite', {
  input: AddFavorite,
  run(ctx, payload) {
    ctx.tags.persistent('favorite').add(payload.key);
  },
});

const rooms = base.channel(['rooms', 'room:{id}'], {
  membership: 'persistent',
  capabilities: [inbox(), readReceipts()],
  outgoing: {
    emits: {
      'room-msg': t<RoomMsg>(),
    },
  },
});

export const handleSendRoomMsg = rooms.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    ctx.channel.broadcast('room-msg', { text: payload.text, from: ctx.meta.username });
  },
});

// `rooms` carries the `inbox: true` / `readReceipts: true` client-contract
// flags, so it is passed to `assemble` for `InferClient` to expose the
// inbox/readReceipts surface for the family.
export const inboxDynamicHandler = base.assemble({
  handlers: [handleServerDrop, handleSendTopMsg, handleAddFavorite, handleSendRoomMsg, rooms],
});

export type InboxDynamicClient = InferClient<typeof inboxDynamicHandler>;
