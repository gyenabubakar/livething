import { scope } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { base } from '../setup.ts';
import { RoomMessage, RoomSend } from './events.ts';

export const dynamicRoomChannel = withChannels(base).channel(scope('rooms', /^room:.+$/), (ch) =>
  ch
    .outgoing(RoomMessage)
    .incoming(RoomSend, (ctx, payload) => {
      const msg = { text: payload.text, from: ctx.meta.username, room: ctx.channel.name };
      ctx.channel.send('room-message', msg);
      ctx.channel.broadcast('room-message', msg);
    })
    .onBeforeSubscribe((ctx) => {
      if (ctx.meta.username === 'banned-user') {
        throw new Error('You are banned from rooms');
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
