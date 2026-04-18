import { scope } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { base } from '../setup.ts';
import { RoomEchoParam, RoomMessage, RoomParamResult, RoomSend } from './events.ts';

const dynamicBase = withChannels(base);

export const dynamicRoomChannel = dynamicBase.channel(scope('rooms', /^room:.+$/), (ch) =>
  ch
    .outgoing(RoomMessage)
    .outgoing(RoomParamResult)
    .incoming(RoomSend, (ctx, payload) => {
      const msg = { text: payload.text, from: ctx.meta.username, room: ctx.channel.name };
      ctx.channel.send('room-message', msg);
      ctx.channel.broadcast('room-message', msg);
    })
    .incoming(RoomEchoParam, (ctx) => {
      const suffix = ctx.channel.name.startsWith('room:')
        ? ctx.channel.name.slice('room:'.length)
        : '';
      ctx.channel.send('room-param-result', { name: ctx.channel.name, suffix });
    })
    .onBeforeSubscribe(async (ctx) => {
      if (ctx.meta.username === 'banned-user') {
        throw new Error('You are banned from rooms');
      }
      if (ctx.meta.username === 'async-banned-user') {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('Async-rejected from rooms');
      }
    })
    .onSubscribe((ctx) => {
      ctx.channel.broadcast('room-message', {
        text: `${ctx.meta.username} entered ${ctx.channel.name}`,
        from: 'system',
        room: ctx.channel.name,
      });
    })
    .onUnsubscribe((ctx) => {
      ctx.channel.broadcast('room-message', {
        text: `${ctx.meta.username} left ${ctx.channel.name}`,
        from: 'system',
        room: ctx.channel.name,
      });
    }),
);
