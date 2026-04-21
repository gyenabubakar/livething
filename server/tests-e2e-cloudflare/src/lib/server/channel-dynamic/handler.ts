import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event('room-message', v.object({ text: v.string(), from: v.string() }));
const SendMessage = event('send-message', v.object({ text: v.string() }));

const base = withChannels(withLifecycle(server<Env>('channel-dynamic'))).onUpgrade((request) =>
  requireUsername(request),
);

const roomChannel = base.channel(scope('room', /^room:.+$/), (ch) =>
  ch.outgoing(RoomMessage).incoming(SendMessage, (ctx, payload) => {
    ctx.channel.broadcast('room-message', {
      text: payload.text,
      from: ctx.meta.username,
    });
  }),
);

export const channelDynamicHandler = base.use(roomChannel).build();
