import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event(
  'room-message',
  v.object({
    channel: v.string(),
    text: v.string(),
    from: v.string(),
    kind: v.string(),
  }),
);
const SendMessage = event('send-message', v.object({ text: v.string() }));
const EchoName = event('echo-name', v.object({}));
const NameResult = event('name-result', v.object({ name: v.string(), suffix: v.string() }));

const base = withChannels(withLifecycle(server<Env>('channel-dynamic'))).onUpgrade((request) =>
  requireUsername(request),
);

const roomChannel = base.channel(scope('room', /^room:.+$/), (ch) =>
  ch
    .outgoing(RoomMessage)
    .outgoing(NameResult)
    .incoming(SendMessage, (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        channel: ctx.channel.name,
        text: payload.text,
        from: ctx.meta.username,
        kind: 'user',
      });
    })
    .incoming(EchoName, (ctx) => {
      const name = ctx.channel.name;
      const suffix = name.slice(name.indexOf(':') + 1);
      ctx.channel.send('name-result', { name, suffix });
    })
    .onBeforeSubscribe(async (ctx) => {
      if (ctx.meta.username === 'banned-user') {
        throw new Error('banned-user may not subscribe');
      }
      if (ctx.meta.username === 'async-banned-user') {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('async-banned-user may not subscribe');
      }
    })
    .onSubscribe((ctx) => {
      ctx.channel.broadcast('room-message', {
        channel: ctx.channel.name,
        text: `${ctx.meta.username} entered`,
        from: 'system',
        kind: 'system',
      });
    })
    .onUnsubscribe((ctx) => {
      ctx.channel.broadcast('room-message', {
        channel: ctx.channel.name,
        text: `${ctx.meta.username} left`,
        from: 'system',
        kind: 'system',
      });
    }),
);

export const channelDynamicHandler = base.use(roomChannel).build();
