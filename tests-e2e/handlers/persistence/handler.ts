import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import { Disconnect } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { allowAnonymous, requireUsername } from '../_shared/upgrade.ts';

const RoomMessagePayload = v.object({ text: v.string(), from: v.string() });
const SendMessagePayload = v.object({ text: v.string() });
const SessionEndedPayload = v.object({ channel: v.string(), username: v.string() });
const TrueLeavePayload = v.object({ channel: v.string(), username: v.string() });
const RemoveMemberPayload = v.object({ identity: v.string() });

export const persistenceContract = contract('persistence', {
  env: t<Env>(),
  persistence: true,
  meta: t<{ username: string }>(),
  definitions: [
    outgoing('true-leave', TrueLeavePayload),
    incoming('remove-member', RemoveMemberPayload),
    incoming('ban', RemoveMemberPayload),

    // Test support: a server-initiated retryable close (warm reconnect) and a
    // per-subscribe-flow ack so a test can count how many times the archive-room
    // subscribe flow runs across a reconnect (auto-rejoin vs client re-subscribe).
    incoming('server-drop', v.object({})),
    outgoing('subscribe-flow-ran', v.object({ channel: v.string(), username: v.string() })),

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

    // Persistent channel with a capacity commit gate (one live member). Proves
    // commit is NOT re-run on auto-rejoin: a returning member keeps its seat even
    // when another live member now fills the cap.
    channel('capacity-room', {
      definitions: [outgoing('room-message', RoomMessagePayload)],
    }),
  ],
});

export const persistenceHandler = implement(persistenceContract)
  // Default path requires a username (existing tests). Connecting with `?anon`
  // takes the anonymous path (empty identity) so anonymous-skips-membership and
  // anonymous-replay-gate behavior can be exercised.
  .onUpgrade((request) =>
    new URL(request.url).searchParams.has('anon')
      ? allowAnonymous(request)
      : requireUsername(request),
  )

  .on('remove-member', async (ctx, payload) => {
    await ctx.channels.get('archive-room').removeMember(payload.identity);
  })

  // Durable ban: stored under the room's DO so it survives the banned user's
  // disconnect and is visible when their auto-rejoin re-runs the check.
  .on('ban', async (ctx, payload) => {
    await ctx.kv.set(`ban:${payload.identity}`, '1');
  })

  .on('server-drop', () => {
    throw Disconnect(4500, 'test drop');
  })

  .channel('archive-room', (ch) =>
    ch
      // First-subscribe gate.
      .check(async (ctx) => {
        if (await ctx.kv.get(`ban:${ctx.meta.username}`)) {
          throw new Error('banned from archive-room');
        }
      })
      // Re-authorization on auto-rejoin. `check` does not run on rejoin, so the
      // ban must be re-applied here or a banned member would be silently brought
      // back on reconnect. Throwing drops the durable membership.
      .revalidate(async (ctx) => {
        if (await ctx.kv.get(`ban:${ctx.meta.username}`)) {
          throw new Error('banned from archive-room');
        }
      })
      // Fires once per subscribe flow that actually adds the member. Used to
      // observe whether a warm reconnect runs this more than once (server
      // auto-rejoin and a redundant client re-subscribe).
      .onSubscribe((ctx) => {
        ctx.send('subscribe-flow-ran', {
          channel: ctx.channel.name,
          username: ctx.meta.username,
        });
      })
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

  .channel('capacity-room', (ch) =>
    ch.commit((ctx) => {
      // Excludes self (membership is not written yet), so the first member sees 0.
      if (ctx.channel.members().length >= 1) {
        throw new Error('capacity-room full');
      }
    }),
  )

  .build();

export type PersistenceClient = InferClient<typeof persistenceHandler>;
