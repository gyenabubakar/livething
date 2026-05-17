import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withPersistence } from '@wskit/server/persistence';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event('room-message', v.object({ text: v.string(), from: v.string() }));
const SendMessage = event('send-message', v.object({ text: v.string() }));
const SessionEnded = event(
  'session-ended',
  v.object({ channel: v.string(), username: v.string() }),
);
const TrueLeave = event('true-leave', v.object({ channel: v.string(), username: v.string() }));

// Triggers ctx.channels.get('archive-room').removeMember(payload.identity).
// Used by the e2e suite to pin that removeMember kicks the live socket of
// the target identity AND drops its durable row so reconnect does NOT
// auto-rejoin.
const RemoveMember = event('remove-member', v.object({ identity: v.string() }));

const base = withPersistence(withChannels(withLifecycle(server<Env>('persistence'))))
  .onUpgrade((request) => requireUsername(request))
  .enablePersistence()
  .outgoing(TrueLeave);

// Persistent group channel — survives reconnect.
const archiveRoom = base.channel('archive-room', (ch) =>
  ch
    .outgoing(RoomMessage)
    .outgoing(SessionEnded)
    .incoming(SendMessage, (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        text: payload.text,
        from: ctx.meta.username,
      });
    })
    .onUnsubscribe((ctx) => {
      // Fires only on true leave (client _unsubscribe, kick, removeMember).
      // NOT on plain disconnect of this persistent channel.
      ctx.send('true-leave', {
        channel: ctx.channel.name,
        username: ctx.meta.username,
      });
    })
    .onSessionEnd((ctx) => {
      // Fires on every leave path: true leave OR plain disconnect.
      ctx.channel.broadcast('session-ended', {
        channel: ctx.channel.name,
        username: ctx.meta.username,
      });
    }),
);

// Ephemeral channel — IRC-style, members vanish on disconnect.
const typingIndicator = base.channel('typing-indicator', (ch) =>
  ch.persistent(false).outgoing(RoomMessage),
);

export const persistenceHandler = base
  .use(archiveRoom)
  .use(typingIndicator)
  .incoming(RemoveMember, async (ctx, payload) => {
    await ctx.channels.get('archive-room').removeMember(payload.identity);
  })
  .build();
