import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { inbox, readReceipts } from '@wskit/server/inbox';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { SendRoomMsg } from './events.ts';
import type { RoomMsg } from './events.ts';

// Drives delivered and read receipts end to end on an inbox channel. `inbox`
// owns delivered: `__received__` advances `received_through` and answers
// `ctx.channel.inbox.receiversOf(seq)`. `readReceipts` owns read: `markAsRead(seq)`
// advances `read_through` and answers `ctx.channel.readReceipts.readersOf(seq)`.
// inbox fans out `__received__` and readReceipts fans out `__read__`. The
// `cursor-answer` emit surfaces the authoritative server view, independent of
// the live fan-out.
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    channels(),
    sequence({ persist: true }),
    dedup(),
    emits({
      'cursor-answer': t<{ kind: 'received' | 'read'; seq: number; identities: string[] }>(),
    }),
  ],
});

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

export const chat = base.channel('chat', {
  membership: 'persistent',
  capabilities: [inbox({ broadcastReceipts: true }), readReceipts()],
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

const AskCursor = v.object({ kind: v.picklist(['received', 'read']), seq: v.number() });

// The cursor surfaces attach at runtime with no static ctx type yet (deferred
// capability-owned ctx extensions), so the handler casts to reach them.
interface ChannelReceiptsCtx {
  inbox: { receiversOf(seq: number): string[] };
  readReceipts: { readersOf(seq: number): string[] };
}

export const handleAskCursor = chat.on('ask-cursor', {
  input: AskCursor,
  run(ctx, input) {
    const receiptsCtx = ctx.channel as unknown as ChannelReceiptsCtx;
    const identities =
      input.kind === 'read'
        ? receiptsCtx.readReceipts.readersOf(input.seq)
        : receiptsCtx.inbox.receiversOf(input.seq);
    ctx.send('cursor-answer', { kind: input.kind, seq: input.seq, identities });
  },
});

// The channel object `chat` carries the `inbox: true` / `readReceipts: true`
// client-contract flags, so it is passed to `assemble` for `InferClient` to
// expose receiversOf (inbox) and markAsRead/readersOf (readReceipts).
export const receiptsHandler = base.assemble({
  handlers: [handleServerDrop, handleSendRoomMsg, handleAskCursor, chat],
});

export type ReceiptsClient = InferClient<typeof receiptsHandler>;
