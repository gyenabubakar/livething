import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { replay } from '@wskit/server/replay';
import { requests } from '@wskit/server/requests';
import { sequence } from '@wskit/server/sequence';
import { stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import {
  ChatMsg,
  Cursor,
  GetToken,
  InjectFamilyReplay,
  ReplayGuardError,
  RequestHistory,
  RequestRoomHistory,
  RoomMsg,
  SendCursor,
  SendMsg,
  SendRoomMsg,
  StartTinyStream,
  TinyChunk,
  TriggerBadReplay,
  TriggerBigIntReplay,
} from './events.ts';

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'chat-msg': ChatMsg,
      cursor: Cursor,
      'room-msg': RoomMsg,
      'replay-guard-error': ReplayGuardError,
    }),
    requests(),
    dedup(),
    sequence({ persist: true }),
    replay.history({
      exclude: ['cursor'],
      retention: { maxMessages: 100, maxAgeMs: 1_000 },
      durability: 'strict',
    }),
    channels(),
    stream(),
  ],
});

base.error((_ctx, error, event) => {
  console.error(`[replay] error in ${event}:`, error);
});

export const handleSendMsg = base.on('send-msg', {
  input: SendMsg,
  run(ctx, payload) {
    const msg = { text: payload.text, from: ctx.meta.username };
    ctx.send('chat-msg', msg);
    ctx.broadcast('chat-msg', msg);
  },
});

export const handleSendCursor = base.on('send-cursor', {
  input: SendCursor,
  run(ctx, payload) {
    ctx.send('cursor', { x: payload.x, y: payload.y });
    ctx.broadcast('cursor', { x: payload.x, y: payload.y });
  },
});

export const handleRequestHistory = base.on('request-history', {
  input: RequestHistory,
  run(ctx) {
    ctx.sendReplay(
      'chat-msg',
      { text: 'injected-history', from: 'system' },
      { seq: 0, messageId: 'manual-001' },
    );
  },
});

export const handleGetToken = base.request('get-token', {
  input: GetToken,
  run(ctx) {
    return { token: `secret-for-${ctx.meta.username}` };
  },
});

export const handleTriggerBadReplay = base.on('trigger-bad-replay', {
  input: TriggerBadReplay,
  run(ctx) {
    let undeclared = '';
    try {
      // Intentionally an undeclared event to exercise the runtime guard; the
      // type-level surface only accepts declared emits, so cast past it here.
      ctx.sendReplay(
        'not-declared-event' as 'chat-msg',
        { text: 'x', from: 'system' },
        { seq: 0, messageId: 'bad-1' },
      );
    } catch (err) {
      undeclared = err instanceof Error ? err.message : String(err);
    }

    ctx.send('replay-guard-error', { undeclared });
  },
});

export const handleInjectFamilyReplay = base.on('inject-family-replay', {
  input: InjectFamilyReplay,
  run(ctx) {
    ctx.sendReplay(
      'room-msg',
      { text: 'family-injected', from: 'system' },
      { seq: 0, messageId: 'fam-manual-001', channel: 'fam-1', channelScope: 'fams' },
    );
  },
});

export const handleTriggerBigIntReplay = base.on('trigger-bigint-replay', {
  input: TriggerBigIntReplay,
  run(ctx) {
    ctx.sendReplay(
      'chat-msg',
      { text: 'bigint-row', from: 'system', reactions: 7n } as unknown as {
        text: string;
        from: string;
      },
      { seq: 1, messageId: 'bigint-row-1' },
    );
    ctx.sendReplay(
      'chat-msg',
      { text: 'after-bigint-row', from: 'system' },
      { seq: 2, messageId: 'after-bigint-row' },
    );
  },
});

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

export const handleStartTinyStream = base.stream('start-tiny-stream', {
  input: StartTinyStream,
  chunk: TinyChunk,
  async *run() {
    yield { value: 'one' };
  },
});

const replayRoom = base.channel('replay-room', {
  outgoing: {
    emits: {
      'room-msg': RoomMsg,
    },
  },
});

export const handleSendRoomMsg = replayRoom.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    const from = ctx.meta.username;
    const msg = { text: payload.text, from };
    ctx.channel.send('room-msg', msg);
    ctx.channel.broadcast('room-msg', msg);
  },
});

export const handleRequestRoomHistory = replayRoom.on('request-room-history', {
  input: RequestRoomHistory,
  run(ctx) {
    ctx.channel.sendReplay(
      'room-msg',
      { text: 'injected-room-history', from: 'system' },
      { seq: 0, messageId: 'room-manual-001' },
    );
  },
});

const fams = base.channel(['fams', 'fam-{id}'], {
  outgoing: {
    emits: {
      'room-msg': RoomMsg,
    },
  },
});

export const handleFamsSendRoomMsg = fams.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    const from = ctx.meta.username;
    const msg = { text: payload.text, from };
    ctx.channel.broadcast('room-msg', msg);
  },
});

const optoutRoom = base.channel('optout-room', {
  replay: false,
  outgoing: {
    emits: {
      'room-msg': RoomMsg,
    },
  },
});

export const handleOptoutSendRoomMsg = optoutRoom.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    const from = ctx.meta.username;
    const msg = { text: payload.text, from };
    ctx.channel.send('room-msg', msg);
    ctx.channel.broadcast('room-msg', msg);
  },
});

export const replayHandler = base.assemble(
  handleSendMsg,
  handleSendCursor,
  handleRequestHistory,
  handleGetToken,
  handleTriggerBadReplay,
  handleInjectFamilyReplay,
  handleTriggerBigIntReplay,
  handleServerDrop,
  handleStartTinyStream,
  handleSendRoomMsg,
  handleRequestRoomHistory,
  handleFamsSendRoomMsg,
  handleOptoutSendRoomMsg,
);

export type ReplayClient = InferClient<typeof replayHandler>;
