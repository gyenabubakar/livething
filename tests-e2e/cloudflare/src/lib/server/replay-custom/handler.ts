import { channel, contract, implement, incoming, outgoing, stream, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import type { InferClient } from '@wskit/server';
import {
  AddNote,
  AddRoomNote,
  BadReplayLog,
  ConfirmedCount,
  GetConfirmedCount,
  GetRoomConfirmedCount,
  Note,
  QueryBadReplayLog,
  QueryRoomReplayEvents,
  RoomConfirmedCount,
  RoomNote,
  RoomReplayEvents,
  RoomStreamChunk,
  RoomStreamPayload,
} from './events.ts';

export const replayCustomContract = contract<Env>('replay-custom-test')({
  sequence: { persist: true },
  dedup: true,
  meta: t<{ username: string }>(),
  definitions: [
    incoming('add-note', AddNote),
    incoming('query-bad-replay-log', QueryBadReplayLog),
    incoming('get-confirmed-count', GetConfirmedCount),

    outgoing('note', Note),
    outgoing('confirmed-count', ConfirmedCount),
    outgoing('bad-replay-log', BadReplayLog),

    channel('custom-room', {
      definitions: [
        outgoing('room-note', RoomNote),
        outgoing('room-confirmed-count', RoomConfirmedCount),
        outgoing('room-replay-events', RoomReplayEvents),
        incoming('add-room-note', AddRoomNote),
        incoming('get-room-confirmed-count', GetRoomConfirmedCount),
        incoming('query-room-replay-events', QueryRoomReplayEvents),
        stream('room-stream', { payload: RoomStreamPayload, chunk: RoomStreamChunk }),
      ],
    }),
  ],
});

export const replayCustomHandler = implement(replayCustomContract)
  .customReplay({
    onBeforeSend: (ctx, msg) => {
      ctx.sql.exec(
        'INSERT INTO _custom_replay (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
        msg.event,
        JSON.stringify(msg.payload),
        msg.wire.seq,
        msg.wire.messageId,
      );
    },
    onAfterSend: (ctx, msg) => {
      ctx.sql.exec('UPDATE _custom_replay SET confirmed = 1 WHERE seq = ?', msg.wire.seq);
    },
    onReplay: async (ctx, since) => {
      if (since === 2_147_483_647) {
        let undeclared = '';
        let reservedField = '';
        try {
          ctx.sendReplay('not-declared-event', { ok: true }, { seq: 1, messageId: 'bad-1' });
        } catch (err) {
          undeclared = err instanceof Error ? err.message : String(err);
        }
        try {
          ctx.sendReplay(
            'note',
            {
              text: 'x',
              author: 'system',
              _evil: 'leaked',
            },
            { seq: 2, messageId: 'bad-2' },
          );
        } catch (err) {
          reservedField = err instanceof Error ? err.message : String(err);
        }
        ctx.sql.exec(
          'INSERT OR REPLACE INTO _bad_replay_log (id, undeclared, reserved_field) VALUES (1, ?, ?)',
          undeclared,
          reservedField,
        );
        return;
      }

      const rows = (
        ctx.sql.exec(
          'SELECT event, payload, seq, message_id FROM _custom_replay WHERE seq > ? ORDER BY seq ASC',
          since,
        ) as {
          toArray(): Array<{ event: string; payload: string; seq: number; message_id: string }>;
        }
      ).toArray();

      for (const row of rows) {
        ctx.sendReplay(row.event, JSON.parse(row.payload), {
          seq: row.seq,
          messageId: row.message_id,
        });
      }
    },
  })
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { identity: username, meta: { username } };
  })
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
      CREATE TABLE IF NOT EXISTS _bad_replay_log (
        id INTEGER PRIMARY KEY,
        undeclared TEXT NOT NULL DEFAULT '',
        reserved_field TEXT NOT NULL DEFAULT ''
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
  .on('add-note', (ctx, payload) => {
    ctx.send('note', { text: payload.text, author: ctx.meta.username });
    ctx.broadcast('note', { text: payload.text, author: ctx.meta.username });
  })
  .on('query-bad-replay-log', (ctx) => {
    const rows = ctx.sql
      .exec<{
        undeclared: string;
        reserved_field: string;
      }>('SELECT undeclared, reserved_field FROM _bad_replay_log WHERE id = 1')
      .toArray();
    const row = rows[0];
    ctx.send('bad-replay-log', {
      undeclared: row?.undeclared ?? '',
      reservedField: row?.reserved_field ?? '',
    });
  })
  .on('get-confirmed-count', (ctx) => {
    const rows = ctx.sql
      .exec<{
        total: number;
        confirmed: number;
      }>('SELECT COUNT(*) as total, SUM(confirmed) as confirmed FROM _custom_replay')
      .toArray();
    const row = rows[0];
    ctx.send('confirmed-count', { total: row?.total ?? 0, confirmed: row?.confirmed ?? 0 });
  })
  .channel('custom-room', (ch) =>
    ch
      .customReplay({
        onBeforeSend: (ctx, msg) => {
          ctx.sql.exec(
            'INSERT INTO _custom_room_replay (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
            msg.event,
            JSON.stringify(msg.payload),
            msg.wire.seq,
            msg.wire.messageId,
          );
        },
        onAfterSend: (ctx, msg) => {
          ctx.sql.exec('UPDATE _custom_room_replay SET confirmed = 1 WHERE seq = ?', msg.wire.seq);
        },
        onReplay: async (ctx, since) => {
          const rows = (
            ctx.sql.exec(
              'SELECT event, payload, seq, message_id FROM _custom_room_replay WHERE seq > ? ORDER BY seq ASC',
              since,
            ) as {
              toArray(): Array<{
                event: string;
                payload: string;
                seq: number;
                message_id: string;
              }>;
            }
          ).toArray();
          for (const row of rows) {
            ctx.sendReplay(row.event, JSON.parse(row.payload), {
              seq: row.seq,
              messageId: row.message_id,
            });
          }
        },
      })
      .on('add-room-note', (ctx, payload) => {
        ctx.channel.send('room-note', { text: payload.text, author: ctx.meta.username });
        ctx.channel.broadcast('room-note', { text: payload.text, author: ctx.meta.username });
      })
      .on('query-room-replay-events', (ctx) => {
        const rows = ctx.sql
          .exec<{ event: string }>('SELECT DISTINCT event FROM _custom_room_replay')
          .toArray();
        ctx.channel.send('room-replay-events', { events: rows.map((r) => r.event) });
      })
      .stream('room-stream', async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i += 1) {
          yield { token: `tok-${i}` };
        }
      })
      .on('get-room-confirmed-count', (ctx) => {
        const rows = ctx.sql
          .exec<{
            total: number;
            confirmed: number;
          }>('SELECT COUNT(*) as total, SUM(confirmed) as confirmed FROM _custom_room_replay')
          .toArray();
        const row = rows[0];
        ctx.channel.send('room-confirmed-count', {
          total: row?.total ?? 0,
          confirmed: row?.confirmed ?? 0,
        });
      }),
  )
  .build();

export type ReplayCustomClient = InferClient<typeof replayCustomHandler>;
