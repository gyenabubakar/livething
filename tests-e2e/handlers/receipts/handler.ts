import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { inbox, receipts } from '@wskit/server/inbox';
import { persistence } from '@wskit/server/persistence';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { SendRoomMsg } from './events.ts';
import type { RoomMsg } from './events.ts';

// Drives delivered + seen receipts end to end on an inbox channel. Each member's
// `__received__` ack advances a `received_through` cursor; `markSeen(seq)`
// advances `seen_through`. Both fan out to the channel as `__receipt__` frames
// (broadcast threshold left unlimited here). The server always answers
// `ctx.channel.receipts.receivedBy(seq)` / `seenBy(seq)` from the cursor table —
// surfaced through the `cursor-answer` emit so a spec can assert the authoritative
// server view, independent of the live `__receipt__` fan-out.
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    persistence(),
    channels(),
    sequence({ persist: true }),
    dedup(),
    inbox(),
    receipts(),
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
  receipts: { seen: true },
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

// The server-side receipts cursor surface `receipts()` attaches at runtime under
// `ctx.channel.receipts`. It has no static type on `ChannelHandle` yet (a
// deferred capability-owned ctx extension), so the handler casts to reach it.
interface ChannelReceiptsCtx {
  receipts: {
    receivedBy(seq: number): string[];
    seenBy(seq: number): string[];
  };
}

export const handleAskCursor = chat.on('ask-cursor', {
  input: AskCursor,
  run(ctx, input) {
    const receiptsCtx = ctx.channel as unknown as ChannelReceiptsCtx;
    const identities =
      input.kind === 'seen'
        ? receiptsCtx.receipts.seenBy(input.seq)
        : receiptsCtx.receipts.receivedBy(input.seq);
    ctx.send('cursor-answer', { kind: input.kind, seq: input.seq, identities });
  },
});

// The channel object `chat` carries the `inbox: true` / `receipts: true`
// client-contract flags (its handler values do not), so it is passed to
// `assemble` for `InferClient` to expose `markSeen`/`onReceipt`/`receipts`.
export const receiptsHandler = base.assemble(
  handleServerDrop,
  handleSendRoomMsg,
  handleAskCursor,
  chat,
);

export type ReceiptsClient = InferClient<typeof receiptsHandler>;
