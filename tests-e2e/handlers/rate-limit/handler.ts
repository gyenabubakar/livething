import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { rateLimit } from '@livething/server/rate-limit';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMsgPayload = v.object({ text: v.string() });
const EchoReqPayload = v.object({ text: v.string() });

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    rateLimit({ windowMs: 60_000, max: 3 }),
    channels(),
    clientRequests(),
    emits({
      tock: t<{ n: number }>(),
      'expensive-done': t<{}>(),
      'shared-done': t<{}>(),
    }),
  ],
});

let tockCounter = 0;

const handleTick = base.on('tick', {
  input: v.object({}),
  run(ctx) {
    tockCounter += 1;
    ctx.send('tock', { n: tockCounter });
  },
});

const handleExpensive = base.on('expensive', {
  input: v.object({}),
  rateLimit: { max: 1 },
  run(ctx) {
    ctx.send('expensive-done', {});
  },
});

// Custom `per` key shares one budget across every socket of the same user.
// Two connections with the same username draw from a single bucket — unlike
// the default per-connection isolation.
const handleSharedTick = base.on('shared-tick', {
  input: v.object({}),
  rateLimit: { max: 2, per: (ctx) => ctx.meta.username },
  run(ctx) {
    ctx.send('shared-done', {});
  },
});

// Top-level request — per-handler override max=1; proves an __error__ frame on
// rate-limited rejection preserves correlationId.
const handleEchoReq = base.request('echo-req', {
  input: EchoReqPayload,
  rateLimit: { max: 1 },
  run(ctx, input) {
    return { text: input.text };
  },
});

// Channel with no rateLimit — inherits the top-level rule (shares bucket).
const inheritRoom = base.channel('inherit-room', {
  capabilities: [emits({ msg: t<{ text: string }>() })],
});

const handleInheritSend = inheritRoom.on('send', {
  input: RoomMsgPayload,
  run(ctx, p) {
    ctx.channel.broadcast('msg', p, { includeSelf: true });
  },
});

// Channel exempt from the cap.
const noLimit = base.channel('no-limit', {
  capabilities: [emits({ msg: t<{ text: string }>() })],
  rateLimit: false,
});

const handleNoLimitSend = noLimit.on('send', {
  input: RoomMsgPayload,
  run(ctx, p) {
    ctx.channel.broadcast('msg', p, { includeSelf: true });
  },
});

// Channel with its own scope rule plus an inner per-handler override.
const rooms = base.channel('rooms', {
  capabilities: [emits({ 'chatter-broadcast': t<{ text: string }>() })],
  rateLimit: { max: 50 },
});

const handleChatter = rooms.on('chatter', {
  input: RoomMsgPayload,
  rateLimit: { max: 1 },
  run(ctx, p) {
    ctx.channel.broadcast('chatter-broadcast', p, { includeSelf: true });
  },
});

// Channel whose OWN scope rule caps the whole channel. Both events share the
// channel-scope bucket.
const tightRoom = base.channel('tight-room', {
  capabilities: [emits({ 'tight-broadcast': t<{ text: string }>() })],
  rateLimit: { max: 2 },
});

const handleAlpha = tightRoom.on('alpha', {
  input: RoomMsgPayload,
  run(ctx, p) {
    ctx.channel.broadcast('tight-broadcast', p, { includeSelf: true });
  },
});

const handleBeta = tightRoom.on('beta', {
  input: RoomMsgPayload,
  run(ctx, p) {
    ctx.channel.broadcast('tight-broadcast', p, { includeSelf: true });
  },
});

export const rateLimitDefinition = base.assemble({
  handlers: [
    handleTick,
    handleExpensive,
    handleSharedTick,
    handleEchoReq,
    handleInheritSend,
    handleNoLimitSend,
    handleChatter,
    handleAlpha,
    handleBeta,
  ],
});

export type RateLimitClient = InferClient<typeof rateLimitDefinition>;
