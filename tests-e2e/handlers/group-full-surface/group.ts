import { emits, t } from '@livething/server';
import * as v from 'valibot';
import {
  BadPayload,
  base,
  ChatPayload,
  FeedChunk,
  GroupRequestKey,
  LookupReq,
  SendMsgPayload,
  TokenChunk,
} from './contract.ts';
import type { RoomMsgPayload } from './contract.ts';

export const handleChat = base.on('chat', {
  input: ChatPayload,
  rateLimit: { max: 1, windowMs: 60_000 },
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

export const handleTick = base.scheduled('tick', {
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
