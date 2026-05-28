import { channel, contract, implement, incoming, outgoing, scope, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Note = v.object({ text: v.string() });
const SendNote = v.object({ text: v.string() });

export const replayCustomCascadeContract = contract('replay-custom-cascade', {
  env: t<Env>(),
  sequence: { persist: true },
  dedup: true,
  meta: t<{ username: string }>(),
  definitions: [
    channel('lobby', {
      definitions: [outgoing('note', Note), incoming('send-note', SendNote)],
    }),
    channel(scope('rooms', /^room-.+$/), {
      definitions: [outgoing('note', Note), incoming('send-note', SendNote)],
    }),
  ],
});

export const replayCustomCascadeHandler = implement(replayCustomCascadeContract)
  .customReplay({
    onBeforeSend: (ctx, msg) => {
      ctx.sql.exec(
        'INSERT INTO _cascade_replay (event, payload, seq, message_id, channel, channel_scope) VALUES (?, ?, ?, ?, ?, ?)',
        msg.event,
        JSON.stringify(msg.payload),
        msg.wire.seq,
        msg.wire.messageId,
        msg.wire.channel,
        msg.wire.channelScope,
      );
    },
    onReplay: (ctx, since) => {
      const requestedChannel = ctx.request.channel;
      const requestedScope = ctx.request.channelScope;
      type Row = {
        event: string;
        payload: string;
        seq: number;
        message_id: string;
        channel: string | null;
        channel_scope: string | null;
      };
      const rows: Row[] = requestedChannel
        ? (
            ctx.sql.exec(
              'SELECT event, payload, seq, message_id, channel, channel_scope FROM _cascade_replay WHERE seq > ? AND channel = ? AND ((channel_scope IS NULL AND ? IS NULL) OR channel_scope = ?) ORDER BY seq ASC',
              since,
              requestedChannel,
              requestedScope,
              requestedScope,
            ) as { toArray(): Row[] }
          ).toArray()
        : (
            ctx.sql.exec(
              'SELECT event, payload, seq, message_id, channel, channel_scope FROM _cascade_replay WHERE seq > ? AND channel IS NULL ORDER BY seq ASC',
              since,
            ) as { toArray(): Row[] }
          ).toArray();

      for (const row of rows) {
        ctx.sendReplay(row.event, JSON.parse(row.payload), {
          seq: row.seq,
          messageId: row.message_id,
          channel: row.channel ?? undefined,
          channelScope: row.channel_scope ?? null,
        });
      }
    },
  })
  .onUpgrade((request) => requireUsername(request))
  .onInit((ctx) => {
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS _cascade_replay (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        channel TEXT,
        channel_scope TEXT
      )
    `);
  })
  .channel('lobby', (c) =>
    c.on('send-note', (ctx, payload) => {
      ctx.channel.send('note', { text: payload.text });
      ctx.channel.broadcast('note', { text: payload.text });
    }),
  )
  .channel('rooms', (c) =>
    c.on('send-note', (ctx, payload) => {
      ctx.channel.send('note', { text: payload.text });
      ctx.channel.broadcast('note', { text: payload.text });
    }),
  )
  .build();

export type ReplayCustomCascadeClient = InferClient<typeof replayCustomCascadeHandler>;
