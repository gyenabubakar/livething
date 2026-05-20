import { channel, contract, implement, incoming, outgoing, stream, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessagePayload = v.object({
  text: v.string(),
  from: v.string(),
  kind: v.string(),
});
const SendMessagePayload = v.object({ text: v.string() });
const StartChannelStreamPayload = v.object({ count: v.number() });
const ChannelTokenPayload = v.object({ index: v.number() });
const TagSelfPayload = v.object({ tag: v.string() });
const TagAckPayload = v.object({ tag: v.string() });
const KickByTagPayload = v.object({ tag: v.string(), reason: v.string() });
const KickAckPayload = v.object({ tag: v.string() });

export const channelStaticContract = contract<Env>('channel-static')({
  meta: t<{ username: string }>(),
  tagGroups: {
    ephemeral: ['user', 'label'],
  },
  definitions: [
    incoming('tag-self', TagSelfPayload),
    incoming('kick-by-tag', KickByTagPayload),
    incoming('trigger-server-subscribe', v.object({})),

    outgoing('tag-ack', TagAckPayload),
    outgoing('kick-ack', KickAckPayload),

    channel('room', {
      definitions: [
        incoming('send-message', SendMessagePayload),
        incoming('trigger-bad-broadcast', v.object({})),
        outgoing('room-message', RoomMessagePayload),
        stream('start-channel-stream', {
          payload: StartChannelStreamPayload,
          chunk: ChannelTokenPayload,
        }),
      ],
    }),

    channel('room2', {
      definitions: [
        incoming('send-message', SendMessagePayload),
        outgoing('room-message', RoomMessagePayload),
      ],
    }),
  ],
});

export const channelStaticHandler = implement(channelStaticContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .onDisconnect((ctx) => {
    if (ctx.meta.username === 'throwing-user') {
      throw new Error('intentional onDisconnect throw');
    }
  })

  .on('tag-self', (ctx, payload) => {
    ctx.tags.ephemeral('label').add(payload.tag);
    ctx.send('tag-ack', { tag: payload.tag });
  })
  .on('kick-by-tag', async (ctx, payload) => {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral('label').ref(payload.tag), payload.reason);
    ctx.send('kick-ack', { tag: payload.tag });
  })
  .on('trigger-server-subscribe', async (ctx) => {
    await ctx.channels.get('room2').subscribe(ctx.self);
  })

  .channel('room', (ch) =>
    ch
      .onBeforeSubscribe((ctx) => {
        if (ctx.meta.username === 'blocked-user') {
          throw new Error('blocked-user may not subscribe');
        }
      })
      .onSubscribe((ctx) => {
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
      })
      .onUnsubscribe((ctx) => {
        ctx.channel.broadcast('room-message', {
          text: `${ctx.meta.username} left`,
          from: 'system',
          kind: 'system',
        });
        if (ctx.meta.username.startsWith('leave-thrower')) {
          throw new Error('intentional onUnsubscribe throw');
        }
      })
      .on('send-message', (ctx, payload) => {
        ctx.channel.broadcast('room-message', {
          text: payload.text,
          from: ctx.meta.username,
          kind: 'user',
        });
      })
      .on('trigger-bad-broadcast', (ctx) => {
        ctx.channel.broadcast('room-message', {
          text: 'bad',
          from: ctx.meta.username,
          kind: 'user',
          reactions: 1n,
        } as unknown as { text: string; from: string; kind: string });
      })
      .stream('start-channel-stream', async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i++) {
          yield { index: i };
          await new Promise((r) => setTimeout(r, 30));
        }
      }),
  )

  .channel('room2', (ch) =>
    ch.on('send-message', (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        text: payload.text,
        from: ctx.meta.username,
        kind: 'user',
      });
    }),
  )

  .build();

export type ChannelStaticClient = InferClient<typeof channelStaticHandler>;
