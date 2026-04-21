import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event(
  'room-message',
  v.object({ text: v.string(), from: v.string(), kind: v.string() }),
);
const SendMessage = event('send-message', v.object({ text: v.string() }));

const base = withChannels(withLifecycle(server<Env>('channel-static'))).onUpgrade((request) =>
  requireUsername(request),
);

const roomChannel = base.channel('room', (ch) =>
  ch
    .outgoing(RoomMessage)
    .incoming(SendMessage, (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        text: payload.text,
        from: ctx.meta.username,
        kind: 'user',
      });
    })
    .onBeforeSubscribe((ctx) => {
      if (ctx.meta.username === 'blocked-user') {
        throw new Error('blocked-user may not subscribe');
      }
    })
    .onSubscribe((ctx) => {
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
    }),
);

export const channelStaticHandler = base.use(roomChannel).build();
