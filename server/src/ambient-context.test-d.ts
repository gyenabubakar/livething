/* oxlint-disable no-unused-vars */
import { t } from '~/_api/index.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { expectTypeOf } from 'vitest';
import type { InitContext } from '~/context.ts';
import { context } from './ambient-context.ts';

const base = server({
  upgrade: () => ({ userId: 'u1', meta: { role: 'admin' as const } }),
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

// task, init, shutdown, upgrade.
expectTypeOf(context.task(base)).not.toBeNever();
expectTypeOf(context.init(base)).toEqualTypeOf<InitContext>();
expectTypeOf(context.upgrade(base)).toEqualTypeOf<InitContext>();
context.shutdown(base).closeAll();

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

context.channelGate(lobby).channel.broadcast('hello', { who: 'x' });

// @ts-expect-error a bare object is not a base
context.connection({});

// @ts-expect-error an object with only __baseId is not a base
context.connection({ __baseId: Symbol('x') });

const pluginBase = server({ scope: 'plugin' });
// @ts-expect-error a plugin's own base is not accepted
context.connection(pluginBase);
