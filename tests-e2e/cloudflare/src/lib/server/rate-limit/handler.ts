import {
  channel,
  contract,
  implement,
  incoming,
  namespace,
  outgoing,
  request,
  t,
} from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const TickPayload = v.object({});
const TockPayload = v.object({ n: v.number() });
const ExpensivePayload = v.object({});
const ExpensiveDonePayload = v.object({});
const RoomMsgPayload = v.object({ text: v.string() });
const EchoReqPayload = v.object({ text: v.string() });
const EchoResPayload = v.object({ text: v.string() });
const StrictPingPayload = v.object({});
const StrictPongPayload = v.object({});
const FastPingPayload = v.object({});
const FastPongPayload = v.object({});

export const rateLimitContract = contract('rate-limit', {
  env: t<Env>(),
  rateLimit: { enabled: true, windowMs: 60_000, max: 3 },
  meta: t<{ username: string }>(),
  definitions: [
    incoming('tick', TickPayload),
    incoming('expensive', ExpensivePayload),
    outgoing('tock', TockPayload),
    outgoing('expensive-done', ExpensiveDonePayload),

    // Top-level request — per-handler override max=1; used to prove that an
    // _error frame on rate-limited rejection preserves _correlationId.
    request('echo-req', { payload: EchoReqPayload, response: EchoResPayload }),

    // Channel with no rateLimit — inherits the top-level rule (shares bucket).
    channel('inherit-room', {
      definitions: [incoming('send', RoomMsgPayload), outgoing('msg', RoomMsgPayload)],
    }),

    // Channel exempt from the cap.
    channel('no-limit', {
      rateLimit: { enabled: false },
      definitions: [incoming('send', RoomMsgPayload), outgoing('msg', RoomMsgPayload)],
    }),

    // Channel with its own scope rule plus an inner per-handler override.
    channel('rooms', {
      rateLimit: { enabled: true, max: 50 },
      definitions: [
        incoming('chatter', RoomMsgPayload),
        outgoing('chatter-broadcast', RoomMsgPayload),
      ],
    }),

    // Namespace with a stricter cap than the top-level.
    namespace('strict', {
      rateLimit: { enabled: true, max: 2 },
      definitions: [
        incoming('strict-ping', StrictPingPayload),
        outgoing('strict-pong', StrictPongPayload),
      ],
    }),

    // Namespace with a tight window so a recovery test stays fast.
    namespace('fast-refill', {
      rateLimit: { enabled: true, windowMs: 2_000, max: 2 },
      definitions: [incoming('fast-ping', FastPingPayload), outgoing('fast-pong', FastPongPayload)],
    }),
  ],
});

let tockCounter = 0;

export const rateLimitHandler = implement(rateLimitContract)
  .onUpgrade((request) => requireUsername(request))
  .rateLimit('expensive', { enabled: true, max: 1 })
  .rateLimit('echo-req', { enabled: true, max: 1 })
  .on('tick', (ctx) => {
    tockCounter += 1;
    ctx.send('tock', { n: tockCounter });
  })
  .on('expensive', (ctx) => {
    ctx.send('expensive-done', {});
  })
  .request('echo-req', (ctx, payload) => {
    ctx.respond({ text: payload.text });
  })
  .channel('inherit-room', (ch) =>
    ch.on('send', (ctx, p) => {
      ctx.channel.broadcast('msg', p, { excludeSelf: false });
    }),
  )
  .channel('no-limit', (ch) =>
    ch.on('send', (ctx, p) => {
      ctx.channel.broadcast('msg', p, { excludeSelf: false });
    }),
  )
  .channel('rooms', (ch) =>
    ch.rateLimit('chatter', { enabled: true, max: 1 }).on('chatter', (ctx, p) => {
      ctx.channel.broadcast('chatter-broadcast', p, { excludeSelf: false });
    }),
  )
  .namespace('strict', (ns) =>
    ns.on('strict-ping', (ctx) => {
      ctx.namespace.send('strict-pong', {});
    }),
  )
  .namespace('fast-refill', (ns) =>
    ns.on('fast-ping', (ctx) => {
      ctx.namespace.send('fast-pong', {});
    }),
  )
  .build();

export type RateLimitClient = InferClient<typeof rateLimitHandler>;
