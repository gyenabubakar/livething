import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { persistence } from '@wskit/server/persistence';
import { replay } from '@wskit/server/replay';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Note = v.object({ text: v.string() });
const SendNote = v.object({ text: v.string() });

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [dedup(), sequence({ persist: true }), persistence(), channels(), replay.custom()],
});

base.init((ctx) => {
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
});

base.replay({
  beforeSend: (ctx, msg) => {
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
  replay: (ctx, since) => {
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
});

const lobby = base.channel('lobby', {
  outgoing: { emits: { note: Note } },
});

const handleLobbySendNote = lobby.on('send-note', {
  input: SendNote,
  run(ctx, input) {
    ctx.channel.send('note', { text: input.text });
    ctx.channel.broadcast('note', { text: input.text });
  },
});

const room = base.channel(['rooms', 'room-{id}'], {
  outgoing: { emits: { note: Note } },
});

const handleRoomSendNote = room.on('send-note', {
  input: SendNote,
  run(ctx, input) {
    ctx.channel.send('note', { text: input.text });
    ctx.channel.broadcast('note', { text: input.text });
  },
});

export const replayCustomCascadeHandler = base.assemble(handleLobbySendNote, handleRoomSendNote);

export type ReplayCustomCascadeClient = InferClient<typeof replayCustomCascadeHandler>;
