/* oxlint-disable no-unused-vars */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox } from '~/inbox/capability.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { expectTypeOf } from 'vitest';
import type { InitContext } from '~/context.ts';
import { context } from './ambient-context.ts';

const base = server({
  authenticate: () => ({ userId: 'u1', meta: { role: 'admin' as const } }),
  capabilities: [emits({ ping: t<{ n: number }>() }), scheduled({ tick: null }), channels()],
});
const rooms = base.channel(['rooms', 'room:{roomId}'], {
  capabilities: [emits({ tick: t<{ n: number }>() })],
});
const lobby = base.channel('lobby', {
  capabilities: [emits({ hello: t<{ who: string }>() })],
});

const plain = server({ capabilities: [emits({ pong: t<{ ok: boolean }>() })] });

// connection: the same ctx type a handler of this base receives.
const connectionCtx = context.connection(base);
connectionCtx.send('ping', { n: 1 });
// @ts-expect-error not an event this base emits
connectionCtx.send('pong', { ok: true });
// @ts-expect-error wrong payload
connectionCtx.send('ping', { n: 'x' });
expectTypeOf(connectionCtx.meta.role).toEqualTypeOf<'admin'>();
connectionCtx.schedule;

// Capability gating follows the base.
const plainCtx = context.connection(plain);
plainCtx.send('pong', { ok: true });
// @ts-expect-error plain does not list scheduled()
plainCtx.schedule;

// task, init, shutdown, authenticate.
expectTypeOf(context.task(base)).toEqualTypeOf(context.shutdown(base));
expectTypeOf(context.task(base).connections.all()[0]!.meta.role).toEqualTypeOf<'admin'>();
context.task(base).broadcast('ping', { n: 1 });
// @ts-expect-error not an event this base emits
context.task(base).broadcast('pong', { ok: true });
// @ts-expect-error a task ctx has no connection, so no `user`
context.task(base).user;
expectTypeOf(context.init(base)).toEqualTypeOf<InitContext>();
expectTypeOf(context.authenticate(base)).toEqualTypeOf<InitContext>();
context.shutdown(base).closeConnections();

// channel: params and events come from the channel itself.
const roomsCtx = context.channel(rooms);
expectTypeOf(roomsCtx.channel.params.roomId).toEqualTypeOf<string>();
roomsCtx.channel.broadcast('tick', { n: 1 });
// @ts-expect-error not an event of this channel
roomsCtx.channel.broadcast('hello', { who: 'x' });
// @ts-expect-error unknown param
roomsCtx.channel.params.nope;
roomsCtx.send('ping', { n: 1 });
expectTypeOf(roomsCtx.meta.role).toEqualTypeOf<'admin'>();

const lobbyCtx = context.channel(lobby);
lobbyCtx.channel.broadcast('hello', { who: 'x' });
// @ts-expect-error not an event of this channel
lobbyCtx.channel.broadcast('tick', { n: 1 });

context.channelLifecycle(lobby).channel.broadcast('hello', { who: 'x' });
context.channelGate(lobby).channel.broadcast('hello', { who: 'x' });

// The accessor returns exactly the `ctx` that a `check` hook of a channel like `lobby` receives.
base.channel('gated', {
  capabilities: [emits({ hello: t<{ who: string }>() })],
  check(ctx) {
    expectTypeOf(ctx).toEqualTypeOf<ReturnType<typeof context.channelGate<typeof lobby>>>();
  },
});

// The lifecycle hooks (onSubscribe, onUnsubscribe, onSessionEnd) have a channel's own handles. The gate
// hooks (check, commit, revalidate) do not, so their accessor must not promise them.
const inboxChannel = base.channel('inboxed', { capabilities: [inbox()] });
context.channelLifecycle(inboxChannel).channel.inbox;
// @ts-expect-error check, commit and revalidate have no inbox
context.channelGate(inboxChannel).channel.inbox;

// @ts-expect-error a bare object is not a base
context.connection({});

// @ts-expect-error an object with only __baseId is not a base
context.connection({ __baseId: Symbol('x') });

const pluginBase = server({ scope: 'plugin' });
// A plugin's own base works in every accessor, inside that plugin's code.
context.connection(pluginBase);
context.task(pluginBase);
expectTypeOf(context.authenticate(pluginBase)).toEqualTypeOf<InitContext>();
