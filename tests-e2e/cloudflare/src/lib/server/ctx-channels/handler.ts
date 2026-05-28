import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const ctxChannelsContract = contract('ctx-channels', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  tagGroups: {
    ephemeral: ['user'],
  },
  definitions: [
    incoming('get-members', v.object({ channel: v.string() })),
    incoming('get-member-id', v.object({ channel: v.string() })),
    incoming(
      'kick-in-channel',
      v.object({ channel: v.string(), tag: v.string(), reason: v.string() }),
    ),
    incoming('kick-nonmember', v.object({})),

    outgoing('members-result', v.object({ channel: v.string(), count: v.number() })),
    outgoing('member-id-result', v.object({ id: v.string() })),

    channel('room', {
      definitions: [
        incoming('send-room-message', v.object({ text: v.string() })),
        outgoing('room-message', v.object({ text: v.string(), from: v.string() })),
      ],
    }),
  ],
});

export const ctxChannelsHandler = implement(ctxChannelsContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .on('get-members', (ctx, payload) => {
    void payload;
    ctx.send('members-result', {
      channel: 'room',
      count: ctx.channels.get('room').members().length,
    });
  })
  .on('get-member-id', (ctx, payload) => {
    void payload;
    const members = ctx.channels.get('room').members();
    const first = members[0];
    ctx.send('member-id-result', { id: first ? first.id : '' });
  })
  .on('kick-in-channel', async (ctx, payload) => {
    void payload.channel;
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral('user').ref(payload.tag), payload.reason);
  })
  .on('kick-nonmember', async (ctx) => {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral('user').ref('user3'), 'Non-existent user');
  })
  .channel('room', (ch) =>
    ch.on('send-room-message', (ctx, payload) => {
      ctx.channel.broadcast('room-message', { text: payload.text, from: ctx.meta.username });
    }),
  )
  .build();

export type CtxChannelsClient = InferClient<typeof ctxChannelsHandler>;
