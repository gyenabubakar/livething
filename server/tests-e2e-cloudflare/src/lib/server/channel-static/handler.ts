import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withRequests } from '@wskit/server/requests';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event('room-message', v.object({ text: v.string(), from: v.string() }));
const SendMessage = event('send-message', v.object({ text: v.string() }));
const GetInfo = event('get-info', v.object({}));
const InfoResponseSchema = v.object({ channel: v.string() });

const base = withRequests(withChannels(withLifecycle(server<Env>('channel-static')))).onUpgrade(
  (request) => requireUsername(request),
);

const roomChannel = base.channel('room', (ch) =>
  ch
    .outgoing(RoomMessage)
    .incoming(SendMessage, (ctx, payload) => {
      ctx.channel.broadcast('room-message', { text: payload.text, from: ctx.meta.username });
    })
    .request(GetInfo, InfoResponseSchema, (ctx) => {
      ctx.respond({ channel: ctx.channel.name });
    }),
);

export const channelStaticHandler = base.use(roomChannel).build();
