import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withHibernation } from '@wskit/server/hibernation';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const BroadcastToRoom = event('broadcast-to-room', v.object({ text: v.string() }));
const RoomMessage = event('room-message', v.object({ text: v.string() }));

const base = withChannels(withHibernation(withLifecycle(server<Env>('hibernation'))))
  .hibernation()
  .onUpgrade((request) => requireUsername(request));

const roomChannel = base.channel('room', (c) =>
  c.outgoing(RoomMessage).incoming(BroadcastToRoom, (ctx, payload) => {
    ctx.channel.broadcast('room-message', { text: payload.text });
  }),
);

export const hibernationHandler = base.use(roomChannel).build();
