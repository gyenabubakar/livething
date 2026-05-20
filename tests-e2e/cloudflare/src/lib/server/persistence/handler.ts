import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessagePayload = v.object({ text: v.string(), from: v.string() });
const SendMessagePayload = v.object({ text: v.string() });
const SessionEndedPayload = v.object({ channel: v.string(), username: v.string() });
const TrueLeavePayload = v.object({ channel: v.string(), username: v.string() });
const RemoveMemberPayload = v.object({ identity: v.string() });

export const persistenceContract = contract<Env>('persistence')({
  persistence: true,
  meta: t<{ username: string }>(),
  definitions: [
    outgoing('true-leave', TrueLeavePayload),
    incoming('remove-member', RemoveMemberPayload),

    channel('archive-room', {
      definitions: [
        outgoing('room-message', RoomMessagePayload),
        outgoing('session-ended', SessionEndedPayload),
        incoming('send-message', SendMessagePayload),
      ],
    }),

    channel('typing-indicator', {
      persistent: false,
      definitions: [outgoing('room-message', RoomMessagePayload)],
    }),
  ],
});

export const persistenceHandler = implement(persistenceContract)
  .onUpgrade((request) => requireUsername(request))

  .on('remove-member', async (ctx, payload) => {
    await ctx.channels.get('archive-room').removeMember(payload.identity);
  })

  .channel('archive-room', (ch) =>
    ch
      .on('send-message', (ctx, payload) => {
        ctx.channel.broadcast('room-message', {
          text: payload.text,
          from: ctx.meta.username,
        });
      })
      .onUnsubscribe((ctx) => {
        ctx.send('true-leave', {
          channel: ctx.channel.name,
          username: ctx.meta.username,
        });
      })
      .onSessionEnd((ctx) => {
        ctx.channel.broadcast('session-ended', {
          channel: ctx.channel.name,
          username: ctx.meta.username,
        });
      }),
  )

  .build();

export type PersistenceClient = InferClient<typeof persistenceHandler>;
