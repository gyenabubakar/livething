import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { stream } from '@livething/server/streams';
import { tags } from '@livething/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsernameWithUserTag } from '../_shared/authenticate.ts';

const SendMessagePayload = v.object({ text: v.string() });
const StartChannelStreamPayload = v.object({ count: v.number() });
const TagSelfPayload = v.object({ tag: v.string() });
const KickByTagPayload = v.object({ tag: v.string(), reason: v.string() });

const base = server({
  authenticate: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    channels(),
    stream(),
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())]),
    emits({
      'tag-ack': t<{ tag: string }>(),
      'kick-ack': t<{ tag: string }>(),
      'kick-failed': t<{ tag: string; failures: number }>(),
    }),
  ],
  onDisconnect(ctx) {
    if (ctx.meta.username === 'throwing-user') {
      throw new Error('intentional onDisconnect throw');
    }
  },
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
    try {
      await ctx.channels
        .get('room')
        .kick(ctx.tags.ephemeral('label').ref(payload.tag), { reason: payload.reason });
    } catch (error) {
      if (!(error instanceof AggregateError)) throw error;

      // Every tagged member was still kicked; only their leave hooks failed.
      ctx.send('kick-failed', { tag: payload.tag, failures: error.errors.length });
      return;
    }

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
  capabilities: [emits({ 'room-message': t<{ text: string; from: string; kind: string }>() })],
  check(ctx) {
    if (ctx.meta.username === 'blocked-user') {
      throw new Error('blocked-user may not subscribe');
    }
  },
  onSubscribe(ctx) {
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
  },
  onUnsubscribe(ctx) {
    ctx.channel.broadcast('room-message', {
      text: `${ctx.meta.username} left`,
      from: 'system',
      kind: 'system',
    });
    if (ctx.meta.username.startsWith('leave-thrower')) {
      throw new Error('intentional onUnsubscribe throw');
    }
  },
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
  async *run(_ctx, payload) {
    for (let i = 0; i < payload.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 30));
    }
  },
});

const room2 = base.channel('room2', {
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

export const channelStaticDefinition = base.assemble({
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

export type ChannelStaticClient = InferClient<typeof channelStaticDefinition>;
