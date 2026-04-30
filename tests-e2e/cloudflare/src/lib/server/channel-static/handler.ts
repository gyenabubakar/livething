import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event(
  'room-message',
  v.object({ text: v.string(), from: v.string(), kind: v.string() }),
);
const SendMessage = event('send-message', v.object({ text: v.string() }));
const StartChannelStream = event('start-channel-stream', v.object({ count: v.number() }));
const ChannelToken = v.object({ index: v.number() });

const base = withStreams(withChannels(withLifecycle(server<Env>('channel-static'))))
  .onUpgrade((request) => requireUsername(request))
  // A disconnect hook that throws for one specific username — used to pin
  // that handleConnectionClose contains the throw so the rest of the
  // close cleanup (channel leaves, _memberLeave fan-out) still runs.
  .onDisconnect((ctx) => {
    if (ctx.meta.username === 'throwing-user') {
      throw new Error('intentional onDisconnect throw');
    }
  });

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
    .stream(StartChannelStream, (s) =>
      s.chunk(ChannelToken).generate(async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i++) {
          yield { index: i };
          await new Promise((r) => setTimeout(r, 30));
        }
      }),
    )
    .onBeforeSubscribe((ctx) => {
      if (ctx.meta.username === 'blocked-user') {
        throw new Error('blocked-user may not subscribe');
      }
    })
    .onSubscribe((ctx) => {
      // ctx.channel.name is the static name 'room' — verify it's accessible
      if (ctx.channel.name !== 'room') {
        throw new Error(`expected channel.name to be 'room', got ${ctx.channel.name}`);
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
    }),
);

export const channelStaticHandler = base.use(roomChannel).build();
