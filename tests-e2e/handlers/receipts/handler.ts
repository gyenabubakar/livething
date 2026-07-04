import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { inbox, readReceipts } from '@wskit/server/inbox';
import { persistence } from '@wskit/server/persistence';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { SendRoomMsg } from './events.ts';
import type { RoomMsg } from './events.ts';

// Drives delivered and read receipts end to end on an inbox channel. `inbox`
// owns delivered: `__received__` advances `received_through` and answers
// `ctx.channel.inbox.receivedBy(seq)`. `readReceipts` owns read: `markSeen(seq)`
// advances `seen_through` and answers `ctx.channel.readReceipts.seenBy(seq)`.
// Both fan out as `__receipt__` frames. The `cursor-answer` emit surfaces the
// authoritative server view, independent of the live fan-out.
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    persistence(),
    channels(),
    sequence({ persist: true }),
    dedup(),
    inbox(),
    readReceipts(),
    emits({
      'cursor-answer': t<{ kind: 'received' | 'seen'; seq: number; identities: string[] }>(),
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
  persistent: true,
  inbox: true,
  readReceipts: true,
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

const AskCursor = v.object({ kind: v.picklist(['received', 'seen']), seq: v.number() });

// The cursor surfaces attach at runtime with no static ctx type yet (deferred
// capability-owned ctx extensions), so the handler casts to reach them.
interface ChannelReceiptsCtx {
  inbox: { receivedBy(seq: number): string[] };
  readReceipts: { seenBy(seq: number): string[] };
}

export const handleAskCursor = chat.on('ask-cursor', {
  input: AskCursor,
  run(ctx, input) {
    const receiptsCtx = ctx.channel as unknown as ChannelReceiptsCtx;
    const identities =
      input.kind === 'seen'
        ? receiptsCtx.readReceipts.seenBy(input.seq)
        : receiptsCtx.inbox.receivedBy(input.seq);
    ctx.send('cursor-answer', { kind: input.kind, seq: input.seq, identities });
  },
});

// The channel object `chat` carries the `inbox: true` / `readReceipts: true`
// client-contract flags, so it is passed to `assemble` for `InferClient` to
// expose receivedBy (inbox) and markSeen/seenBy (readReceipts).
export const receiptsHandler = base.assemble(
  handleServerDrop,
  handleSendRoomMsg,
  handleAskCursor,
  chat,
);

export type ReceiptsClient = InferClient<typeof receiptsHandler>;
