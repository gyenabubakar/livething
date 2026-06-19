/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: a channel that declares its own server→client requests
 * in `outgoing.requests`. Inside the channel handler, `ctx.channel.request`
 * (targeted) and `ctx.channel.broadcastRequest` (fan-out) are typed to the
 * channel's own declarations, and the `{ broadcast: true }` flag decides which
 * verb each declaration is answerable through.
 */
import { t } from '~/_api/index.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { requests } from '~/request/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { ConnectionRef } from '~/context.ts';

const base = define({
  env: t<{}>(),
  capabilities: [requests(), channels()],
});

const room = base.channel(['room', 'room:{id}'], {
  outgoing: {
    emits: { tick: t<{ n: number }>() },
    requests: {
      'confirm-kick': [t<{ target: string }>(), v.object({ ok: v.boolean() })],
      vol: [t<{}>(), v.object({ r: v.boolean() }), { broadcast: true }],
    },
  },
});

const lobby = base.channel('lobby', {
  outgoing: {
    emits: { joined: t<{ who: string }>() },
    requests: {
      greet: [t<{}>(), v.object({ hi: v.boolean() }), { broadcast: true }],
    },
  },
});

/**
 * From any handler, `ctx.channels.get(...)` is fully typed when passed a channel
 * declaration (static) or a family's `.at(params)` ref: `send`/`broadcast` to the
 * channel's emits, `broadcastRequest` to its broadcast requests. `.at()` exists
 * only on dynamic family declarations.
 */
base.on('drive', {
  run(ctx) {
    expectTypeOf(ctx.channels.get(lobby).send('joined', { who: 'a' })).toEqualTypeOf<boolean>();
    expectTypeOf(ctx.channels.get(lobby).broadcastRequest('greet', {})).toEqualTypeOf<
      Promise<{ readonly response: { hi: boolean }; readonly from: ConnectionRef }>
    >();

    // @ts-expect-error — an undeclared emit on the channel is rejected.
    void ctx.channels.get(lobby).send('nope', {});

    // @ts-expect-error — a static channel has no .at(); it is already a ref.
    void lobby.at({ id: 'x' });

    const ref = room.at({ id: 'general' });
    expectTypeOf(ctx.channels.get(ref).send('tick', { n: 1 })).toEqualTypeOf<boolean>();
    expectTypeOf(ctx.channels.get(ref).broadcastRequest('vol', {})).toEqualTypeOf<
      Promise<{ readonly response: { r: boolean }; readonly from: ConnectionRef }>
    >();

    // @ts-expect-error — the emit payload must match the channel's declaration.
    void ctx.channels.get(ref).send('tick', { n: 'x' });

    // @ts-expect-error — .at() needs the template's {id} param.
    void room.at({});

    // @ts-expect-error — a targeted declaration is not answerable via broadcastRequest.
    void ctx.channels.get(ref).broadcastRequest('confirm-kick', { target: 'x' });
  },
});

room.on('ping', {
  run(ctx) {
    // Targeted declaration via request → Promise of its declared response.
    expectTypeOf(ctx.channel.request('confirm-kick', { target: 'x' })).toEqualTypeOf<
      Promise<{ ok: boolean }>
    >();

    // Broadcast declaration via broadcastRequest → { response, from }.
    expectTypeOf(ctx.channel.broadcastRequest('vol', {})).toEqualTypeOf<
      Promise<{ readonly response: { r: boolean }; readonly from: ConnectionRef }>
    >();

    // @ts-expect-error — a broadcast declaration is not answerable via request.
    void ctx.channel.request('vol', {});

    // @ts-expect-error — a targeted declaration is not answerable via broadcastRequest.
    void ctx.channel.broadcastRequest('confirm-kick', { target: 'x' });

    // @ts-expect-error — the targeted request payload must match the declaration.
    void ctx.channel.request('confirm-kick', { target: 1 });

    // @ts-expect-error — an undeclared event is rejected.
    void ctx.channel.request('nope', {});
  },
});

/**
 * Without the `requests()` capability, declaring `outgoing.requests` is a
 * compile-time error (excess property), matching the gating on the
 * `ctx.channel.request` / `broadcastRequest` verbs — not just a runtime throw.
 */
const noRequests = define({
  env: t<{}>(),
  capabilities: [channels()],
});

// @ts-expect-error — outgoing.requests needs the requests() capability listed;
// the inferred declaration map fails its capability-gated constraint, erroring here.
noRequests.channel(['room', 'room:{id}'], {
  outgoing: {
    emits: { tick: t<{ n: number }>() },
    requests: { ask: [t<{}>(), v.object({ ok: v.boolean() })] },
  },
});

// The error surfaces on the call when the inferred declaration map fails its
// capability-gated constraint; this fixture proves a request-less channel with
// only emits still type-checks.
noRequests.channel(['lobby', 'lobby:{id}'], {
  outgoing: { emits: { tick: t<{ n: number }>() } },
});
