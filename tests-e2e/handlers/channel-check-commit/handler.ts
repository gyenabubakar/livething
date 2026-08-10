import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { Disconnect } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

// Stand-in for a real token store (database, auth service, etc.).
const TOKEN_ROLES: Record<string, 'member' | 'vip' | 'banned'> = {
  'tok-member': 'member',
  'tok-vip': 'vip',
  'tok-banned': 'banned',
};

const SendPayload = v.object({ text: v.string() });

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [channels()],
});

// Uses both check and commit: check validates the token, commit enforces the capacity.
const room = base.channel('room', {
  outgoing: {
    emits: {
      message: t<{ from: string; text: string }>(),
      joined: t<{ username: string }>(),
    },
  },
  subscribe: v.object({ token: v.string() }),
  async check(_ctx, input) {
    // `input` is the validated subscribe payload, typed from the channel's subscribe schema.
    await new Promise((r) => setTimeout(r, 5));
    const { token } = input;
    const role = token ? TOKEN_ROLES[token] : undefined;
    if (!role) throw new Error('unknown or missing token');
    return { role };
  },
  // TypeScript infers `role` from what check returned — no manual annotation needed.
  commit(ctx, { role }) {
    if (role === 'banned') throw new Error('banned role may not subscribe');

    // Throwing here prevents the subscriber from being added.
    if (ctx.channel.members().length >= 2) throw new Error('room is full');
  },
});

room.subscribe((ctx) => {
  ctx.channel.broadcast('joined', { username: ctx.meta.username }, { includeSelf: true });
});

const handleRoomSend = room.on('send', {
  input: SendPayload,
  run(ctx, input) {
    ctx.channel.broadcast('message', { from: ctx.meta.username, text: input.text });
  },
});

// Uses only check — shows that commit is optional.
const checkOnly = base.channel('check-only', {
  outgoing: { emits: { joined: t<{ username: string }>() } },
  async check(ctx) {
    await new Promise((r) => setTimeout(r, 5));
    if (ctx.meta.username === 'no-access') throw new Error('no-access user is not allowed');
  },
});

checkOnly.subscribe((ctx) => {
  ctx.channel.broadcast('joined', { username: ctx.meta.username }, { includeSelf: true });
});

// Uses only commit — shows that check is optional.
const commitOnly = base.channel('commit-only', {
  outgoing: { emits: { joined: t<{ username: string }>() } },
  commit(ctx) {
    if (ctx.channel.members().length >= 1)
      throw new Error('commit-only room allows one subscriber');
  },
});

commitOnly.subscribe((ctx) => {
  ctx.channel.broadcast('joined', { username: ctx.meta.username }, { includeSelf: true });
});

// Misuse: an async commit. commit() must be synchronous; the engine rejects
// a returned Promise. This fixture exists to pin the wire behavior.
const asyncCommit = base.channel('async-commit', {
  outgoing: { emits: { joined: t<{ username: string }>() } },
  commit: (async () => {
    await new Promise((r) => setTimeout(r, 1));
  }) as unknown as () => void,
});

// A check that rejects a token it has already seen (nonce / replay protection).
// Used to prove the client re-subscribes with a FRESH payload on reconnect: a
// stale (reused) token is refused, a function-generated one is admitted. Stays
// ephemeral (`persistent: false`) so a reconnect requires a real client-driven
// re-subscribe through `check`, instead of a server auto-rejoin through
// `revalidate`.
const nonceRoom = base.channel('nonce-room', {
  persistent: false,
  outgoing: { emits: { joined: t<{ username: string }>() } },
  subscribe: v.object({ token: v.string() }),
  async check(ctx, input) {
    // Reject a token that's been used before. A stale snapshot resent on
    // reconnect lands here and is refused; a freshly generated one passes.
    const { token } = input;
    if (!token) throw new Error('missing token');
    const key = `nonce:${token}`;
    if (await ctx.kv.get(key)) throw new Error('token already used');
    await ctx.kv.set(key, true);
  },
});

nonceRoom.subscribe((ctx) => {
  ctx.channel.broadcast('joined', { username: ctx.meta.username }, { includeSelf: true });
});

// Test support: a server-initiated retryable close so the client reconnects
// in-session and re-subscribes.
const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

export const channelCheckCommitHandler = base.assemble({
  handlers: [handleRoomSend, checkOnly, commitOnly, asyncCommit, nonceRoom, handleServerDrop],
});

export type ChannelCheckCommitClient = InferClient<typeof channelCheckCommitHandler>;
