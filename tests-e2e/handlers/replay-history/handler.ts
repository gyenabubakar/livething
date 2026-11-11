import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { dedup } from '@livething/server/dedup';
import { Disconnect } from '@livething/server/errors';
import { plugin } from '@livething/server/plugins';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import { stream } from '@livething/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';
import {
  GetToken,
  InjectFamilyReplay,
  PingAll,
  PluginMsg,
  RequestHistory,
  RequestRoomHistory,
  SendCursor,
  SendMsg,
  SendRoomMsg,
  SendToUser,
  StartTinyStream,
  TriggerBadReplay,
  TriggerBigIntReplay,
} from './events.ts';
import type { ChatMsg, Cursor, ReplayGuardError, RoomMsg } from './events.ts';

// A tiny scoped plugin that owns one top-level broadcast event. It lists no
// replay of its own — a plugin cannot own the host-only replay engine. Its
// `plugin-msg` broadcast rides out namespaced as `__e2e:replay::plugin-msg`,
// and the host's top-level replay stores and re-delivers it like any other
// outgoing frame. This is the proof that app-level replay covers plugin events.
const pluginBase = server({
  scope: 'plugin',
  capabilities: [emits({ 'plugin-msg': PluginMsg })],
});

const handlePluginPingAll = pluginBase.on('ping-all', {
  input: PingAll,
  run(ctx, payload) {
    // A broadcast is recorded once for replay, the same way the top-level
    // `chat-msg` handler seeds a replayable row.
    ctx.broadcast('plugin-msg', { text: payload.text }, { includeSelf: true });
  },
});

export const ReplayPlugin = plugin('e2e:replay', {
  definition: pluginBase.assemble({ handlers: [handlePluginPingAll] }),
});

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'chat-msg': t<v.InferOutput<typeof ChatMsg>>(),
      cursor: t<v.InferOutput<typeof Cursor>>(),
      'room-msg': t<v.InferOutput<typeof RoomMsg>>(),
      'replay-guard-error': t<v.InferOutput<typeof ReplayGuardError>>(),
    }),
    clientRequests(),
    dedup(),
    sequence({ persist: true }),
    replay.history({
      exclude: ['cursor'],
      retention: { maxMessages: 100, maxAgeMs: 1_000 },
      durability: 'strict',
    }),
    channels(),
    stream(),
    ReplayPlugin(),
  ],
  onError(_ctx, error, event) {
    console.error(`[replay] error in ${event}:`, error);
  },
});

export const handleSendMsg = base.on('send-msg', {
  input: SendMsg,
  run(ctx, payload) {
    const msg = { text: payload.text, from: ctx.meta.username };
    ctx.broadcast('chat-msg', msg, { includeSelf: true });
  },
});

export const handleSendCursor = base.on('send-cursor', {
  input: SendCursor,
  run(ctx, payload) {
    ctx.broadcast('cursor', { x: payload.x, y: payload.y }, { includeSelf: true });
  },
});

// A private reply to the caller only. Replay records it under the caller's
// resume token, so only a client that comes back from this connection reads it.
export const handleSendPrivate = base.on('send-private', {
  input: SendMsg,
  run(ctx, payload) {
    ctx.send('chat-msg', { text: payload.text, from: 'private' });
  },
});

// A message addressed to one user. Replay records it for that user only.
export const handleSendToUser = base.on('send-to-user', {
  input: SendToUser,
  run(ctx, payload) {
    ctx.users.get(payload.userId).broadcast('chat-msg', { text: payload.text, from: 'dm' });
  },
});

// A broadcast to everyone except the caller. Replay records it even when the
// caller is the only connection, so nobody receives it live.
export const handleShout = base.on('shout', {
  input: SendMsg,
  run(ctx, payload) {
    ctx.broadcast('chat-msg', { text: payload.text, from: ctx.meta.username });
  },
});

export const handleRequestHistory = base.on('request-history', {
  input: RequestHistory,
  run(ctx) {
    ctx.sendReplay(
      'chat-msg',
      { text: 'injected-history', from: 'system' },
      { deliverySeq: 0, messageId: 'manual-001' },
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
        { deliverySeq: 0, messageId: 'bad-1' },
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
      { deliverySeq: 0, messageId: 'fam-manual-001', channel: fams.at({ id: '1' }) },
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
      { deliverySeq: 1, messageId: 'bigint-row-1' },
    );
    ctx.sendReplay(
      'chat-msg',
      { text: 'after-bigint-row', from: 'system' },
      { deliverySeq: 2, messageId: 'after-bigint-row' },
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
  async *run() {
    yield { value: 'one' };
  },
});

const replayRoom = base.channel('replay-room', {
  capabilities: [
    emits({
      'room-msg': t<v.InferOutput<typeof RoomMsg>>(),
    }),
  ],
});

export const handleSendRoomMsg = replayRoom.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    const from = ctx.meta.username;
    const msg = { text: payload.text, from };
    ctx.channel.broadcast('room-msg', msg, { includeSelf: true });
  },
});

// A channel broadcast to every member except the caller. Replay records it
// even when the caller is the channel's only member.
export const handleShoutRoom = replayRoom.on('shout-room', {
  input: SendRoomMsg,
  run(ctx, payload) {
    ctx.channel.broadcast('room-msg', { text: payload.text, from: ctx.meta.username });
  },
});

export const handleRequestRoomHistory = replayRoom.on('request-room-history', {
  input: RequestRoomHistory,
  run(ctx) {
    const sendReplay = ctx.channel.sendReplay;
    if (!sendReplay) {
      throw new Error('channel replay is not active for replay-room');
    }

    sendReplay(
      'room-msg',
      { text: 'injected-room-history', from: 'system' },
      { deliverySeq: 0, messageId: 'room-manual-001' },
    );
  },
});

const fams = base.channel(['fams', 'fam-{id}'], {
  capabilities: [
    emits({
      'room-msg': t<v.InferOutput<typeof RoomMsg>>(),
    }),
  ],
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
  capabilities: [
    emits({
      'room-msg': t<v.InferOutput<typeof RoomMsg>>(),
    }),
  ],
});

export const handleOptoutSendRoomMsg = optoutRoom.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    const from = ctx.meta.username;
    const msg = { text: payload.text, from };
    ctx.channel.broadcast('room-msg', msg, { includeSelf: true });
  },
});

export const replayDefinition = base.assemble({
  handlers: [
    handleSendMsg,
    handleSendCursor,
    handleSendPrivate,
    handleSendToUser,
    handleShout,
    handleShoutRoom,
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
  ],
});

export type ReplayClient = InferClient<typeof replayDefinition>;
