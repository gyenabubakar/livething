/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: a channel that declares its own server→client requests
 * with `serverRequests(...)`. Inside the channel handler, `ctx.channel.request`
 * is typed to the channel's own declarations.
 */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { serverRequests } from '~/request/server-requests.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';

const base = server({
  capabilities: [serverRequests(), channels()],
});

const room = base.channel(['room', 'room:{id}'], {
  capabilities: [
    emits({ tick: t<{ n: number }>() }),
    serverRequests({
      'confirm-kick': { out: t<{ target: string }>(), in: v.object({ ok: v.boolean() }) },
      vol: { out: t<{}>(), in: v.object({ r: v.boolean() }) },
    }),
  ],
});

const lobby = base.channel('lobby', {
  capabilities: [emits({ joined: t<{ who: string }>() })],
});

/**
 * From any handler, `ctx.channels.get(...)` is fully typed when passed a channel
 * declaration (static) or a family's `.at(params)` ref: `send`/`broadcastTo`/`broadcast`
 * to the channel's emits. `.at()` exists only on dynamic family declarations.
 */
base.on('drive', {
  run(ctx) {
    expectTypeOf(ctx.channels.get(lobby).send('joined', { who: 'a' })).toEqualTypeOf<number>();
    expectTypeOf(
      ctx.channels.get(lobby).broadcastTo(ctx.user.ref(), 'joined', { who: 'a' }),
    ).toEqualTypeOf<number>();

    // @ts-expect-error — an undeclared emit on the channel is rejected.
    void ctx.channels.get(lobby).send('nope', {});

    // @ts-expect-error — a static channel has no .at(); it is already a ref.
    void lobby.at({ id: 'x' });

    const ref = room.at({ id: 'general' });
    expectTypeOf(ctx.channels.get(ref).send('tick', { n: 1 })).toEqualTypeOf<number>();

    // @ts-expect-error — the emit payload must match the channel's declaration.
    void ctx.channels.get(ref).send('tick', { n: 'x' });

    // @ts-expect-error — .at() needs the template's {id} param.
    void room.at({});
  },
});

room.on('ping', {
  run(ctx) {
    expectTypeOf(ctx.channel.request('confirm-kick', { target: 'x' })).toEqualTypeOf<
      Promise<{ ok: boolean }>
    >();

    void ctx.channel.request('vol', {}, { to: ctx.connection });

    // @ts-expect-error — `to` takes one connection, not a user.
    void ctx.channel.request('vol', {}, { to: ctx.user.ref() });

    // @ts-expect-error — the request payload must match the declaration.
    void ctx.channel.request('confirm-kick', { target: 1 });

    // @ts-expect-error — an undeclared event is rejected.
    void ctx.channel.request('nope', {});
  },
});

/**
 * Without the root `serverRequests()` capability, declaring channel `serverRequests(...)` is a
 * compile-time error (excess property), matching the gating on the
 * `ctx.channel.request` verb — not just a runtime throw.
 */
const noRequests = server({
  capabilities: [channels()],
});

// @ts-expect-error — channel serverRequests(...) needs root serverRequests();
// the inferred declaration map fails its capability-gated constraint, erroring here.
noRequests.channel(['room', 'room:{id}'], {
  capabilities: [
    emits({ tick: t<{ n: number }>() }),
    serverRequests({ ask: { out: t<{}>(), in: v.object({ ok: v.boolean() }) } }),
  ],
});

// The error surfaces on the call when the inferred declaration map fails its
// capability-gated constraint; this fixture proves a request-less channel with
// only emits still type-checks.
noRequests.channel(['lobby', 'lobby:{id}'], {
  capabilities: [emits({ tick: t<{ n: number }>() })],
});

const noRequestRoom = noRequests.channel('room');

// @ts-expect-error - channel request handlers need clientRequests() just like base.request().
noRequestRoom.request('lookup', { run: () => ({ ok: true }) });
