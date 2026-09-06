import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { inbox } from '@wskit/server/inbox';
import { lastSeen } from '@wskit/server/last-seen';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { SendRoomMsg } from './events.ts';
import type { RoomMsg } from './events.ts';

// Drives `ctx.channels.get(name).inbox()` — the channel-handle augmenter — from
// a TOP-LEVEL handler, outside either channel's own scope. `chat` has
// `inbox: true` so its handle's `.inbox()` returns the same backfill /
// receiversOf / backlog surface as the owning scope's `ctx.channel.inbox`.
// `plain` has no inbox config at all, so its handle's `.inbox()` must return
// `null`. `lastSeen()` rides along so `backlog()` fills each member's
// `lastSeenAt` instead of omitting the field.
const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    channels(),
    sequence({ persist: true }),
    dedup(),
    lastSeen(),
    emits({
      'handle-answer': t<{ channel: string; hasInbox: boolean; receiversOf: string[] | null }>(),
      'backlog-answer': t<{ channel: string; entries: BacklogEntry[] | null }>(),
    }),
  ],
});

// Mirrors `InboxBacklogEntry` from `@wskit/server` structurally — that type is
// not re-exported from the package root, so the emit payload spells it out.
interface BacklogEntry {
  userId: string;
  online: boolean;
  heldRows: number;
  receivedThrough: number;
  oldestHeldAt: number;
  lastSeenAt?: number | null;
}

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

export const chat = base.channel('chat', {
  membership: 'persistent',
  capabilities: [
    inbox(),
    emits({
      'room-msg': t<RoomMsg>(),
    }),
  ],
});

export const plain = base.channel('plain', {
  membership: 'persistent',
  capabilities: [
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

export const handleSendPlainMsg = plain.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    ctx.channel.broadcast('room-msg', { text: payload.text, from: ctx.meta.username });
  },
});

const AskHandle = v.object({ channel: v.string(), seq: v.number() });

export const handleAskHandle = base.on('ask-handle', {
  input: AskHandle,
  run(ctx, input) {
    const handle = ctx.channels.get(input.channel);
    const surface = handle.inbox();
    ctx.send('handle-answer', {
      channel: input.channel,
      hasInbox: surface !== null,
      receiversOf: surface ? surface.receiversOf(input.seq) : null,
    });
  },
});

const AskBacklog = v.object({ channel: v.string() });

export const handleAskBacklog = base.on('ask-backlog', {
  input: AskBacklog,
  run(ctx, input) {
    const handle = ctx.channels.get(input.channel);
    const surface = handle.inbox();
    ctx.send('backlog-answer', {
      channel: input.channel,
      entries: surface ? surface.backlog() : null,
    });
  },
});

// Both channels carry the `inbox: true` / no-flag client-contract shape needed
// for `InferClient` to type the receipts surface only where it applies.
export const inboxHandleHandler = base.assemble({
  handlers: [
    handleServerDrop,
    handleSendRoomMsg,
    handleSendPlainMsg,
    handleAskHandle,
    handleAskBacklog,
    chat,
    plain,
  ],
});

export type InboxHandleClient = InferClient<typeof inboxHandleHandler>;
