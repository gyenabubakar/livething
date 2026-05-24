import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

// Stand-in for a real token store (database, auth service, etc.).
const TOKEN_ROLES: Record<string, 'member' | 'vip' | 'banned'> = {
  'tok-member': 'member',
  'tok-vip': 'vip',
  'tok-banned': 'banned',
};

const JoinedPayload = v.object({ username: v.string() });
const MessagePayload = v.object({ from: v.string(), text: v.string() });
const SendPayload = v.object({ text: v.string() });

export const channelCheckCommitContract = contract<Env>('channel-check-commit')({
  meta: t<{ username: string }>(),
  definitions: [
    // Uses both check and commit: check validates the token, commit enforces the capacity.
    channel('room', {
      check: v.object({ token: v.string() }),
      definitions: [
        incoming('send', SendPayload),
        outgoing('message', MessagePayload),
        outgoing('joined', JoinedPayload),
      ],
    }),

    // Uses only check — shows that commit is optional.
    channel('check-only', {
      definitions: [outgoing('joined', JoinedPayload)],
    }),

    // Uses only commit — shows that check is optional.
    channel('commit-only', {
      definitions: [outgoing('joined', JoinedPayload)],
    }),
  ],
});

export const channelCheckCommitHandler = implement(channelCheckCommitContract)
  .onUpgrade((request) => requireUsername(request))

  .channel('room', (ch) =>
    ch
      .check(async (_ctx, data) => {
        // `data` is typed from the channel's `check` validator — no manual annotation needed.
        await new Promise((r) => setTimeout(r, 5));
        const role = data?.token ? TOKEN_ROLES[data.token] : undefined;
        if (!role) throw new Error('unknown or missing token');
        return { role };
      })
      // TypeScript infers `role` from what check returned — no manual annotation needed.
      .commit((ctx, { role }) => {
        if (role === 'banned') throw new Error('banned role may not subscribe');
        // `ctx.channel.members()` returns the people already in the room.
        // Throwing here prevents the subscriber from being added.
        if (ctx.channel.members().length >= 2) throw new Error('room is full');
      })
      .onSubscribe((ctx) => {
        ctx.channel.broadcast('joined', { username: ctx.meta.username }, { excludeSelf: false });
      })
      .on('send', (ctx, payload) => {
        ctx.channel.broadcast('message', { from: ctx.meta.username, text: payload.text });
      }),
  )

  .channel('check-only', (ch) =>
    ch
      .check(async (ctx) => {
        await new Promise((r) => setTimeout(r, 5));
        if (ctx.meta.username === 'no-access') throw new Error('no-access user is not allowed');
      })
      .onSubscribe((ctx) => {
        ctx.channel.broadcast('joined', { username: ctx.meta.username }, { excludeSelf: false });
      }),
  )

  .channel('commit-only', (ch) =>
    ch
      .commit((ctx) => {
        if (ctx.channel.members().length >= 1)
          throw new Error('commit-only room allows one subscriber');
      })
      .onSubscribe((ctx) => {
        ctx.channel.broadcast('joined', { username: ctx.meta.username }, { excludeSelf: false });
      }),
  )

  .build();

export type ChannelCheckCommitClient = InferClient<typeof channelCheckCommitHandler>;
