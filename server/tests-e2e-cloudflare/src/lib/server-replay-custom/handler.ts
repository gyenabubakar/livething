import { server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplayCustom } from '@wskit/server/replay/custom';
import { withSequence } from '@wskit/server/sequence';
import type { InferClient } from '@wskit/server';
import {
  AddNote,
  AddRoomNote,
  ConfirmedCount,
  GetConfirmedCount,
  GetRoomConfirmedCount,
  Note,
  RoomConfirmedCount,
  RoomNote,
} from './events.ts';

const base = withChannels(
  withReplayCustom(withLifecycle(withSequence(withDedup(server<Env>('replay-custom-test'))))),
)
  .sequence({ persist: true })
  .dedup()
  .outgoing(Note)
  .outgoing(ConfirmedCount)
  .outgoing(RoomNote)
  .outgoing(RoomConfirmedCount)
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { meta: { username } };
  });

export const replayCustomHandler = base
  .replayCustom((r) =>
    r
      .onBeforeSend((ctx, msg) => {
        ctx.sql.exec(
          'INSERT INTO _custom_replay (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
          msg.event,
          JSON.stringify(msg.payload),
          msg.wire.seq,
          msg.wire.messageId,
        );
      })
      .onAfterSend((ctx, msg) => {
        ctx.sql.exec('UPDATE _custom_replay SET confirmed = 1 WHERE seq = ?', msg.wire.seq);
      })
      .onReplay(async (ctx, since) => {
        const rows = ctx.sql
          .exec(
            'SELECT event, payload, seq, message_id FROM _custom_replay WHERE seq > ? ORDER BY seq ASC',
            since,
          )
          .toArray() as { event: string; payload: string; seq: number; message_id: string }[];

        for (const row of rows) {
          ctx.sendReplay(row.event, JSON.parse(row.payload), {
            seq: row.seq,
            messageId: row.message_id,
          });
        }
      }),
  )
  .onInit((ctx) => {
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS _custom_replay (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0
      )
    `);
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS _custom_room_replay (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        channel TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0
      )
    `);
    try {
      ctx.sql.exec('ALTER TABLE _custom_replay ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0');
    } catch {
      // column already exists
    }
    try {
      ctx.sql.exec(
        'ALTER TABLE _custom_room_replay ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0',
      );
    } catch {
      // column already exists
    }
  })
  .incoming(AddNote, (ctx, payload) => {
    ctx.send('note', { text: payload.text, author: ctx.meta.username });
    ctx.broadcast('note', { text: payload.text, author: ctx.meta.username });
  })
  .incoming(GetConfirmedCount, (ctx) => {
    const rows = ctx.sql
      .exec('SELECT COUNT(*) as total, SUM(confirmed) as confirmed FROM _custom_replay')
      .toArray() as { total: number; confirmed: number }[];
    const row = rows[0];
    ctx.send('confirmed-count', { total: row?.total ?? 0, confirmed: row?.confirmed ?? 0 });
  })
  .use(
    base.channel('custom-room', (ch) =>
      ch
        .outgoing(RoomNote)
        .outgoing(RoomConfirmedCount)
        .replayCustom((r) =>
          r
            .onBeforeSend((ctx, msg) => {
              ctx.sql.exec(
                'INSERT INTO _custom_room_replay (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
                msg.event,
                JSON.stringify(msg.payload),
                msg.wire.seq,
                msg.wire.messageId,
              );
            })
            .onAfterSend((ctx, msg) => {
              ctx.sql.exec(
                'UPDATE _custom_room_replay SET confirmed = 1 WHERE seq = ?',
                msg.wire.seq,
              );
            })
            .onReplay(async (ctx, since) => {
              const rows = ctx.sql
                .exec(
                  'SELECT event, payload, seq, message_id FROM _custom_room_replay WHERE seq > ? ORDER BY seq ASC',
                  since,
                )
                .toArray() as { event: string; payload: string; seq: number; message_id: string }[];
              for (const row of rows) {
                ctx.sendReplay(row.event, JSON.parse(row.payload), {
                  seq: row.seq,
                  messageId: row.message_id,
                });
              }
            }),
        )
        .incoming(AddRoomNote, (ctx, payload) => {
          ctx.channel.send('room-note', { text: payload.text, author: ctx.meta.username });
          ctx.channel.broadcast('room-note', { text: payload.text, author: ctx.meta.username });
        })
        .incoming(GetRoomConfirmedCount, (ctx) => {
          const rows = ctx.sql
            .exec('SELECT COUNT(*) as total, SUM(confirmed) as confirmed FROM _custom_room_replay')
            .toArray() as { total: number; confirmed: number }[];
          const row = rows[0];
          ctx.channel.send('room-confirmed-count', {
            total: row?.total ?? 0,
            confirmed: row?.confirmed ?? 0,
          });
        }),
    ),
  )
  .build();

export type ReplayCustomClient = InferClient<typeof replayCustomHandler>;
