import { emits, localKey, t } from '@livething/server';
import * as v from 'valibot';
import {
  BadPayload,
  base,
  ChatPayload,
  FeedChunk,
  LookupReq,
  PaginateChunk,
  SendMsgPayload,
  TokenChunk,
} from './contract.ts';
import type { RoomMsgPayload } from './contract.ts';

const GroupRequestKey = localKey<{ tag: string }>('group-request');

base.onInit((ctx) => {
  ctx.sql.exec(
    'CREATE TABLE IF NOT EXISTS _init_check (id INTEGER PRIMARY KEY, ran INTEGER NOT NULL)',
  );
  ctx.sql.exec('INSERT OR REPLACE INTO _init_check (id, ran) VALUES (1, 1)');
  ctx.sql.exec(
    'CREATE TABLE IF NOT EXISTS _disconnect_log (id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, t INTEGER NOT NULL)',
  );
  ctx.sql.exec(
    'CREATE TABLE IF NOT EXISTS _replay_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, payload TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL)',
  );
  ctx.sql.exec(
    'CREATE TABLE IF NOT EXISTS _scheduled_log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL)',
  );
});

base.onConnect((ctx) => {
  ctx.send('welcome', { username: ctx.meta.username });
});

base.onDisconnect((ctx) => {
  ctx.sql.exec('INSERT INTO _disconnect_log (identity, t) VALUES (?, ?)', ctx.user.id, Date.now());
});

base.onError((ctx, err, eventName) => {
  ctx.send('error-marker', {
    event: eventName,
    msg: err instanceof Error ? err.message : String(err),
  });
});

base.onValidationError((ctx, eventName) => {
  ctx.send('validation-marker', { event: eventName });
});

base.intercept((ctx, frame) => {
  ctx.provide(GroupRequestKey, { tag: 'group' });
  ctx.send('pre-intercept-marker', { event: frame.event });
  // The v2 ctx has no payload-narrowing helper in the built dist yet, so gate
  // on frame.event/frame.kind and cast the raw payload (mirrors intercept/).
  if (frame.kind === 'incoming' && frame.event === 'chat') {
    const p = frame.payload as { text: string };
    ctx.send('post-intercept-marker', { text: p.text });
  }
});

base.replay({
  beforeSend: (ctx, msg) => {
    ctx.sql.exec(
      'INSERT INTO _replay_log (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
      msg.event,
      JSON.stringify(msg.payload),
      msg.wire.deliverySeq,
      msg.wire.messageId,
    );
  },
  replay: (ctx, since) => {
    const rows = (
      ctx.sql.exec(
        'SELECT event, payload, seq, message_id FROM _replay_log WHERE seq > ? ORDER BY seq ASC',
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

export const handleChat = base.on('chat', {
  input: ChatPayload,
  rateLimit: { enabled: true, max: 1, windowMs: 60_000 },
  run(ctx, payload) {
    ctx.send('welcome', { username: ctx.meta.username });
    ctx.send('rl-marker', { at: payload.text.length });
  },
});

export const handleBang = base.on('bang', {
  input: v.object({}),
  run() {
    throw new Error('bang!');
  },
});

export const handleBadPayload = base.on('bad-payload', {
  input: BadPayload,
  run() {
    // Never reached — the schema rejects { wrong: true } first.
  },
});

export const handleCheckInit = base.on('check-init', {
  input: v.object({}),
  run(ctx) {
    const rows = ctx.sql
      .exec<{ ran: number }>('SELECT ran FROM _init_check WHERE id = 1')
      .toArray();
    const ran = rows[0]?.ran ?? 0;
    ctx.send('init-marker', { ran });
  },
});

export const handleCheckDisconnectLog = base.on('check-disconnect-log', {
  input: v.object({ identity: v.string() }),
  run(ctx, payload) {
    const rows = ctx.sql
      .exec<{
        count: number;
      }>('SELECT COUNT(*) as count FROM _disconnect_log WHERE identity = ?', payload.identity)
      .toArray();
    ctx.send('goodbye', { username: `seen:${rows[0]?.count ?? 0}` });
  },
});

export const handleCheckScheduled = base.on('check-scheduled', {
  input: v.object({}),
  run(ctx) {
    const rows = ctx.sql
      .exec<{ count: number }>('SELECT COUNT(*) as count FROM _scheduled_log')
      .toArray();
    ctx.send('scheduled-marker', { tickCount: rows[0]?.count ?? 0 });
  },
});

export const handleStartTick = base.on('start-tick', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('tick', { time: Date.now() + 100 });
  },
});

export const handleEmitReplayMarker = base.on('emit-replay-marker', {
  input: v.object({ note: v.string() }),
  run(ctx, payload) {
    ctx.send('replay-marker', { note: payload.note });
  },
});

export const handleLookup = base.request('lookup', {
  input: LookupReq,
  run(ctx, payload): { found: boolean; hit: string; tag: string } {
    return {
      found: true,
      hit: payload.id,
      tag: ctx.inject(GroupRequestKey)?.tag ?? 'none',
    };
  },
});

export const handleFeed = base.stream('feed', {
  input: v.object({}),
  chunk: FeedChunk,
  async *run() {
    for (let i = 1; i <= 3; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 50));
    }
  },
});

export const handlePaginate = base.resumableStream('paginate', {
  input: v.object({}),
  chunk: PaginateChunk,
  async *run(ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 5; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { idx: i });
      await new Promise((r) => setTimeout(r, 50));
    }
  },
});

export const handleTokens = base.recordedStream('tokens', {
  input: v.object({}),
  chunk: TokenChunk,
  maxChunks: 100,
  async *run() {
    for (let i = 1; i <= 5; i += 1) {
      yield { token: `tok-${i}` };
      await new Promise((r) => setTimeout(r, 50));
    }
  },
});

base.scheduled('tick', {
  run(ctx) {
    ctx.sql.exec('INSERT INTO _scheduled_log (t) VALUES (?)', Date.now());
  },
});

const rooms = base.channel('rooms', {
  capabilities: [emits({ 'room-msg': t<v.InferOutput<typeof RoomMsgPayload>>() })],
});

export const handleRoomSendMsg = rooms.on('send-msg', {
  input: SendMsgPayload,
  run(ctx, payload) {
    ctx.channel.broadcast(
      'room-msg',
      { text: payload.text, from: ctx.meta.username },
      { includeSelf: true },
    );
  },
});
