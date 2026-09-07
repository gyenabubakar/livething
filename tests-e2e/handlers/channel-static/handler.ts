import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { stream } from '@wskit/server/streams';
import { tags } from '@wskit/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsernameWithUserTag } from '../_shared/upgrade.ts';

const SendMessagePayload = v.object({ text: v.string() });
const StartChannelStreamPayload = v.object({ count: v.number() });
const ChannelTokenPayload = t<{ index: number }>();
const TagSelfPayload = v.object({ tag: v.string() });
const KickByTagPayload = v.object({ tag: v.string(), reason: v.string() });

const base = define({
  upgrade: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    channels(),
    stream(),
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())]),
    emits({
      'tag-ack': t<{ tag: string }>(),
      'kick-ack': t<{ tag: string }>(),
    }),
  ],
});

base.onDisconnect((ctx) => {
  if (ctx.meta.username === 'throwing-user') {
    throw new Error('intentional onDisconnect throw');
  }
});

const handleTagSelf = base.on('tag-self', {
  input: TagSelfPayload,
  run(ctx, payload) {
    ctx.tags.ephemeral('label').add(payload.tag);
    ctx.send('tag-ack', { tag: payload.tag });
  },
});

const handleKickByTag = base.on('kick-by-tag', {
  input: KickByTagPayload,
  async run(ctx, payload) {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral('label').ref(payload.tag), { reason: payload.reason });
    ctx.send('kick-ack', { tag: payload.tag });
  },
});

const handleTriggerServerSubscribe = base.on('trigger-server-subscribe', {
  input: v.object({}),
  async run(ctx) {
    await ctx.channels.get('room2').subscribe(ctx.connection);
  },
});

const room = base.channel('room', {
  // Ephemeral: these tests assert that a dropped connection is a true leave
  // (onUnsubscribe fires, __memberLeave__ broadcasts), which only holds when
  // membership does not survive a reconnect.
  membership: 'ephemeral',
  capabilities: [emits({ 'room-message': t<{ text: string; from: string; kind: string }>() })],
  check(ctx) {
    if (ctx.meta.username === 'blocked-user') {
      throw new Error('blocked-user may not subscribe');
    }
  },
});

room.subscribe((ctx) => {
  if (ctx.channel.name !== 'room') {
    throw new Error(`expected channel.name to be 'room', got ${ctx.channel.name}`);
  }

  if (ctx.meta.username === 'subscribe-thrower') {
    throw new Error('intentional onSubscribe throw');
  }

  ctx.channel.broadcast('room-message', {
    text: `${ctx.meta.username} entered`,
    from: 'system',
    kind: 'system',
  });
});

room.unsubscribe((ctx) => {
  ctx.channel.broadcast('room-message', {
    text: `${ctx.meta.username} left`,
    from: 'system',
    kind: 'system',
  });
  if (ctx.meta.username.startsWith('leave-thrower')) {
    throw new Error('intentional onUnsubscribe throw');
  }
});

const handleRoomSendMessage = room.on('send-message', {
  input: SendMessagePayload,
  run(ctx, payload) {
    ctx.channel.broadcast('room-message', {
      text: payload.text,
      from: ctx.meta.username,
      kind: 'user',
    });
  },
});

const handleRoomBadBroadcast = room.on('trigger-bad-broadcast', {
  input: v.object({}),
  run(ctx) {
    ctx.channel.broadcast('room-message', {
      text: 'bad',
      from: ctx.meta.username,
      kind: 'user',
      reactions: 1n,
    } as unknown as { text: string; from: string; kind: string });
  },
});

const handleRoomStream = room.stream('start-channel-stream', {
  input: StartChannelStreamPayload,
  chunk: ChannelTokenPayload,
  async *run(_ctx, payload) {
    for (let i = 0; i < payload.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 30));
    }
  },
});

const room2 = base.channel('room2', {
  // Ephemeral for the same reason as `room` — the multi-channel throw tests
  // drop a connection that is a member of both and expect a true leave on
  // this channel too.
  membership: 'ephemeral',
  capabilities: [emits({ 'room-message': t<{ text: string; from: string; kind: string }>() })],
});

const handleRoom2SendMessage = room2.on('send-message', {
  input: SendMessagePayload,
  run(ctx, payload) {
    ctx.channel.broadcast('room-message', {
      text: payload.text,
      from: ctx.meta.username,
      kind: 'user',
    });
  },
});

export const channelStaticHandler = base.assemble({
  handlers: [
    handleTagSelf,
    handleKickByTag,
    handleTriggerServerSubscribe,
    handleRoomSendMessage,
    handleRoomBadBroadcast,
    handleRoomStream,
    handleRoom2SendMessage,
  ],
});

export type ChannelStaticClient = InferClient<typeof channelStaticHandler>;
