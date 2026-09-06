import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { inbox } from '@wskit/server/inbox';
import { scheduled } from '@wskit/server/scheduled';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { SendRoomMsg } from '../inbox/events.ts';
import type { RoomMsg } from '../inbox/events.ts';

// This handler deliberately keeps delivered rows (`onDelivered: 'retain'`) so
// the raw-wire probe can observe both kinds of row disappearing on the shared
// durable alarm. The top-level recurring task proves that the inbox alarm does
// not replace another capability's scheduled work.
const RETENTION_MS = 1_000;

const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    channels(),
    sequence({ persist: true }),
    dedup(),
    scheduled({ 'retention-heartbeat': { every: 1_000 } }),
    emits({
      'retention-heartbeat': t<{ at: number }>(),
      'retention-answer': t<{
        rows: number;
        deliveredRows: number;
        watermarkRows: number;
        maxEvictedThrough: number | null;
      }>(),
    }),
  ],
});

const chat = base.channel('chat', {
  membership: 'persistent',
  capabilities: [
    inbox({
      onDelivered: 'retain',
      retention: { maxAgeMs: RETENTION_MS },
    }),
    emits({
      'room-msg': t<RoomMsg>(),
    }),
  ],
});

const countChat = base.channel('count', {
  membership: 'persistent',
  capabilities: [
    inbox({ onDelivered: 'retain', retention: { maxMessages: 2 } }),
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

export const handleSendCountMsg = countChat.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    ctx.channel.broadcast('room-msg', { text: payload.text, from: ctx.meta.username });
  },
});

base.scheduled('retention-heartbeat', {
  run(ctx) {
    ctx.broadcast('retention-heartbeat', { at: Date.now() });
  },
});

export const handleRetentionProbe = base.on('probe-retention', {
  input: v.object({}),
  run(ctx) {
    const rows = ctx.sql
      .exec<{ count: number; delivered: number }>(
        `
          SELECT
            COUNT(*) AS count,
            SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered
          FROM __wskit_inbox
        `,
      )
      .one();
    const watermark = ctx.sql
      .exec<{ count: number; max_evicted_through: number | null }>(
        `
          SELECT COUNT(*) AS count, MAX(evicted_through_seq) AS max_evicted_through
          FROM __wskit_inbox_watermark
        `,
      )
      .one();
    ctx.send('retention-answer', {
      rows: Number(rows?.count ?? 0),
      deliveredRows: Number(rows?.delivered ?? 0),
      watermarkRows: Number(watermark?.count ?? 0),
      maxEvictedThrough:
        watermark?.max_evicted_through == null ? null : Number(watermark.max_evicted_through),
    });
  },
});

export const inboxRetentionHandler = base.assemble({
  handlers: [handleSendRoomMsg, handleSendCountMsg, handleRetentionProbe, chat, countChat],
});

export type InboxRetentionClient = InferClient<typeof inboxRetentionHandler>;
