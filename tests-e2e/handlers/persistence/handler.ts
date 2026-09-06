import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { clientRequests } from '@wskit/server/client-requests';
import { Disconnect } from '@wskit/server/errors';
import { resumableStream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { allowAnonymous, requireUsername } from '../_shared/upgrade.ts';

const RoomMessagePayload = v.object({ text: v.string(), from: v.string() });
const SendMessagePayload = v.object({ text: v.string() });
const SessionEndedPayload = v.object({ channel: v.string(), username: v.string() });
const TrueLeavePayload = v.object({ channel: v.string(), username: v.string() });
const RemoveMemberPayload = v.object({ identity: v.string() });

const base = define({
  // Default path requires a username (existing tests). Connecting with `?anon`
  // takes the anonymous path (empty identity) so anonymous-skips-membership and
  // anonymous-replay-gate behavior can be exercised.
  upgrade: (request) =>
    new URL(request.url).searchParams.has('anon')
      ? allowAnonymous(request)
      : requireUsername(request),
  capabilities: [
    channels(),
    clientRequests(),
    resumableStream(),
    emits({
      'true-leave': t<v.InferOutput<typeof TrueLeavePayload>>(),
      // Test support: a per-subscribe-flow ack so a test can count how many times
      // the archive-room subscribe flow runs across a reconnect (auto-rejoin vs
      // client re-subscribe).
      'subscribe-flow-ran': t<{ channel: string; username: string }>(),
    }),
  ],
});

const handleRemoveMember = base.on('remove-member', {
  input: RemoveMemberPayload,
  async run(ctx, input) {
    await ctx.channels
      .get('archive-room')
      .kick(ctx.users.get(input.identity).ref(), { reason: 'removed', revoke: true });
  },
});

// Durable ban: stored under the room's DO so it survives the banned user's
// disconnect and is visible when their auto-rejoin re-runs the check.
const handleBan = base.on('ban', {
  input: RemoveMemberPayload,
  async run(ctx, input) {
    await ctx.kv.set(`ban:${input.identity}`, '1');
  },
});

// Test support: a server-initiated retryable close (warm reconnect).
const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

// Test support for buffered-op ownership: `record-exec` increments a durable
// counter when the server actually runs it, and `read-exec-count` reads it
// back. Proves a buffered request that already timed out is NOT executed after
// a reconnect (the counter stays 0).
const handleRecordExec = base.request('record-exec', {
  input: v.object({}),
  async run(ctx) {
    const next = Number((await ctx.kv.get('exec-count')) ?? '0') + 1;
    await ctx.kv.set('exec-count', String(next));
    return { count: next };
  },
});

const handleReadExecCount = base.request('read-exec-count', {
  input: v.object({}),
  async run(ctx) {
    return { count: Number((await ctx.kv.get('exec-count')) ?? '0') };
  },
});

// Anonymous connections (`upgrade` returned no `userId`) cannot resume a
// stream on reconnect — they have no stable id to key the resume against. The
// engine rejects the start with `DurableStreamRequiresUser` before this runs.
const handleAnonStream = base.resumableStream('anon-stream', {
  input: v.object({}),
  chunk: t<{ n: number }>(),
  async *run() {
    yield { n: 1 };
  },
});

const archiveRoom = base.channel('archive-room', {
  capabilities: [
    emits({
      'room-message': t<v.InferOutput<typeof RoomMessagePayload>>(),
      'session-ended': t<v.InferOutput<typeof SessionEndedPayload>>(),
    }),
  ],
  // First-subscribe gate.
  async check(ctx) {
    if (await ctx.kv.get(`ban:${ctx.meta.username}`)) {
      throw new Error('banned from archive-room');
    }
  },
  // Re-authorization on auto-rejoin. `check` does not run on rejoin, so the
  // ban must be re-applied here or a banned member would be silently brought
  // back on reconnect. Throwing drops the durable membership.
  async revalidate(ctx) {
    if (await ctx.kv.get(`ban:${ctx.meta.username}`)) {
      throw new Error('banned from archive-room');
    }
  },
});

const handleSendMessage = archiveRoom.on('send-message', {
  input: SendMessagePayload,
  run(ctx, input) {
    ctx.channel.broadcast('room-message', {
      text: input.text,
      from: ctx.meta.username,
    });
  },
});

// Fires once per subscribe flow that actually adds the member. Used to observe
// whether a warm reconnect runs this more than once (server auto-rejoin and a
// redundant client re-subscribe).
archiveRoom.subscribe((ctx) => {
  ctx.send('subscribe-flow-ran', {
    channel: ctx.channel.name,
    username: ctx.meta.username,
  });
});

archiveRoom.unsubscribe((ctx) => {
  ctx.send('true-leave', {
    channel: ctx.channel.name,
    username: ctx.meta.username,
  });
});

archiveRoom.sessionEnd((ctx) => {
  ctx.channel.broadcast('session-ended', {
    channel: ctx.channel.name,
    username: ctx.meta.username,
  });
});

const typingIndicator = base.channel('typing-indicator', {
  membership: 'ephemeral',
  capabilities: [emits({ 'room-message': t<v.InferOutput<typeof RoomMessagePayload>>() })],
});

// Persistent channel with a capacity commit gate (one live member). Proves
// commit is NOT re-run on auto-rejoin: a returning member keeps its seat even
// when another live member now fills the cap.
const capacityRoom = base.channel('capacity-room', {
  capabilities: [emits({ 'room-message': t<v.InferOutput<typeof RoomMessagePayload>>() })],
  commit(ctx) {
    // Excludes self (membership is not written yet), so the first member sees 0.
    if (ctx.channel.members().length >= 1) {
      throw new Error('capacity-room full');
    }
  },
});

export const persistenceHandler = base.assemble({
  handlers: [
    handleRemoveMember,
    handleBan,
    handleServerDrop,
    handleRecordExec,
    handleReadExecCount,
    handleAnonStream,
    handleSendMessage,
    typingIndicator,
    capacityRoom,
  ],
});

export type PersistenceClient = InferClient<typeof persistenceHandler>;
