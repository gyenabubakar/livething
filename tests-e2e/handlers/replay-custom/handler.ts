import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import { stream } from '@livething/server/streams';
import type { InferClient } from '@livething/server';
import type * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';
import {
  AddNote,
  AddRoomNote,
  GetConfirmedCount,
  GetRoomConfirmedCount,
  QueryBadReplayLog,
  QueryRoomReplayEvents,
  RoomStreamChunk,
  RoomStreamPayload,
} from './events.ts';
import type {
  BadReplayLog,
  ConfirmedCount,
  Note,
  RoomConfirmedCount,
  RoomNote,
  RoomReplayEvents,
} from './events.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      note: t<v.InferOutput<typeof Note>>(),
      'confirmed-count': t<v.InferOutput<typeof ConfirmedCount>>(),
      'bad-replay-log': t<v.InferOutput<typeof BadReplayLog>>(),
    }),
    dedup(),
    sequence({ persist: true }),
    replay.custom(),
    channels(),
    stream(),
  ],
});

base.replay({
  beforeSend(ctx, msg) {
    ctx.sql.exec(
      'INSERT INTO _custom_replay (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
      msg.event,
      JSON.stringify(msg.payload),
      msg.wire.deliverySeq,
      msg.wire.messageId,
    );
  },
  afterSend(ctx, msg) {
    ctx.sql.exec('UPDATE _custom_replay SET confirmed = 1 WHERE seq = ?', msg.wire.deliverySeq);
  },
  async replay(ctx, since) {
    if (since === 2_147_483_647) {
      let undeclared = '';
      try {
        ctx.sendReplay('not-declared-event', { ok: true }, { deliverySeq: 1, messageId: 'bad-1' });
      } catch (err) {
        undeclared = err instanceof Error ? err.message : String(err);
      }

      ctx.sql.exec(
        'INSERT OR REPLACE INTO _bad_replay_log (id, undeclared) VALUES (1, ?)',
        undeclared,
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
        deliverySeq: row.seq,
        messageId: row.message_id,
      });
    }
  },
});

base.onInit((ctx) => {
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
      undeclared TEXT NOT NULL DEFAULT ''
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
    ctx.sql.exec('ALTER TABLE _custom_room_replay ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0');
  } catch {
    // column already exists
  }
});

const handleAddNote = base.on('add-note', {
  input: AddNote,
  run(ctx, input) {
    ctx.send('note', { text: input.text, author: ctx.meta.username });
    ctx.broadcast('note', { text: input.text, author: ctx.meta.username });
  },
});

const handleQueryBadReplayLog = base.on('query-bad-replay-log', {
  input: QueryBadReplayLog,
  run(ctx) {
    const rows = ctx.sql
      .exec<{
        undeclared: string;
      }>('SELECT undeclared FROM _bad_replay_log WHERE id = 1')
      .toArray();
    const row = rows[0];
    ctx.send('bad-replay-log', {
      undeclared: row?.undeclared ?? '',
    });
  },
});

const handleGetConfirmedCount = base.on('get-confirmed-count', {
  input: GetConfirmedCount,
  run(ctx) {
    const rows = ctx.sql
      .exec<{
        total: number;
        confirmed: number;
      }>('SELECT COUNT(*) as total, SUM(confirmed) as confirmed FROM _custom_replay')
      .toArray();
    const row = rows[0];
    ctx.send('confirmed-count', { total: row?.total ?? 0, confirmed: row?.confirmed ?? 0 });
  },
});

const customRoom = base.channel('custom-room', {
  capabilities: [
    emits({
      'room-note': t<v.InferOutput<typeof RoomNote>>(),
      'room-confirmed-count': t<v.InferOutput<typeof RoomConfirmedCount>>(),
      'room-replay-events': t<v.InferOutput<typeof RoomReplayEvents>>(),
    }),
  ],
});

customRoom.replay({
  beforeSend(ctx, msg) {
    ctx.sql.exec(
      'INSERT INTO _custom_room_replay (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
      msg.event,
      JSON.stringify(msg.payload),
      msg.wire.deliverySeq,
      msg.wire.messageId,
    );
  },
  afterSend(ctx, msg) {
    ctx.sql.exec(
      'UPDATE _custom_room_replay SET confirmed = 1 WHERE seq = ?',
      msg.wire.deliverySeq,
    );
  },
  async replay(ctx, since) {
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
        deliverySeq: row.seq,
        messageId: row.message_id,
      });
    }
  },
});

const handleAddRoomNote = customRoom.on('add-room-note', {
  input: AddRoomNote,
  run(ctx, input) {
    ctx.channel.send('room-note', { text: input.text, author: ctx.meta.username });
    ctx.channel.broadcast('room-note', { text: input.text, author: ctx.meta.username });
  },
});

const handleQueryRoomReplayEvents = customRoom.on('query-room-replay-events', {
  input: QueryRoomReplayEvents,
  run(ctx) {
    const rows = ctx.sql
      .exec<{ event: string }>('SELECT DISTINCT event FROM _custom_room_replay')
      .toArray();
    ctx.channel.send('room-replay-events', { events: rows.map((r) => r.event) });
  },
});

const handleRoomStream = customRoom.stream('room-stream', {
  input: RoomStreamPayload,
  chunk: RoomStreamChunk,
  async *run(_ctx, input) {
    for (let i = 0; i < input.count; i += 1) {
      yield { token: `tok-${i}` };
    }
  },
});

const handleGetRoomConfirmedCount = customRoom.on('get-room-confirmed-count', {
  input: GetRoomConfirmedCount,
  run(ctx) {
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
  },
});

export const replayCustomDefinition = base.assemble({
  handlers: [
    handleAddNote,
    handleQueryBadReplayLog,
    handleGetConfirmedCount,
    handleAddRoomNote,
    handleQueryRoomReplayEvents,
    handleRoomStream,
    handleGetRoomConfirmedCount,
  ],
});

export type ReplayCustomClient = InferClient<typeof replayCustomDefinition>;
