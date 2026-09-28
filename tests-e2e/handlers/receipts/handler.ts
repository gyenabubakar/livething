import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { Disconnect } from '@livething/server/errors';
import { inbox, readReceipts } from '@livething/server/inbox';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
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
const base = server({
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
  capabilities: [
    inbox({ broadcastReceipts: true }),
    readReceipts(),
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

const AskCursor = v.object({ kind: v.picklist(['received', 'read']), seq: v.number() });

export const handleAskCursor = chat.on('ask-cursor', {
  input: AskCursor,
  run(ctx, input) {
    const identities =
      input.kind === 'read'
        ? ctx.channel.readReceipts.readersOf(input.seq)
        : ctx.channel.inbox.receiversOf(input.seq);
    ctx.send('cursor-answer', { kind: input.kind, seq: input.seq, identities });
  },
});

// The channel object `chat` carries the `inbox: true` / `readReceipts: true`
// client-contract flags, so it is passed to `assemble` for `InferClient` to
// expose receiversOf (inbox) and markAsRead/readersOf (readReceipts).
export const receiptsDefinition = base.assemble({
  handlers: [handleServerDrop, handleSendRoomMsg, handleAskCursor, chat],
  api: (ctx) => ({
    seedStaleReceipt() {
      ctx.sql.exec(
        `INSERT OR REPLACE INTO __livething_inbox_receipts
          (channel_name, channel_family, user_id, received_through, read_through, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'old-chat',
        '',
        'alice',
        3,
        3,
        Date.now(),
      );
    },
    staleReceiptCount(): number {
      return Number(
        ctx.sql
          .exec<{
            count: number;
          }>(
            'SELECT COUNT(*) AS count FROM __livething_inbox_receipts WHERE channel_name = ?',
            'old-chat',
          )
          .one()?.count ?? 0,
      );
    },
    dropInboxTable() {
      ctx.sql.exec('DROP TABLE __livething_inbox');
    },
    receiptUsers(channelName: string, seq: number): string[] {
      return ctx.sql
        .exec<{ user_id: string }>(
          `SELECT user_id FROM __livething_inbox_receipts
           WHERE channel_name = ? AND channel_family = ? AND received_through >= ?`,
          channelName,
          '',
          seq,
        )
        .toArray()
        .map((row) => row.user_id);
    },
  }),
});

export type ReceiptsClient = InferClient<typeof receiptsDefinition>;
