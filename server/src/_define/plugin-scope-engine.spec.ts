import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { ValidationFailed } from '~/errors/errors.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { ConnectionHandle } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { plugin } from './plugins.ts';

type WireFrame = [string, Record<string, unknown> | null, Record<string, unknown> | null];

interface OpenSocket {
  handle: ConnectionHandle;
  frames: WireFrame[];
}

function buildEngine(definition: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'plugin-scope-engine',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function open(engine: Engine, userId: string): Promise<OpenSocket> {
  const frames: WireFrame[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: string) => {
      frames.push(JSON.parse(data) as WireFrame);
    },
    close() {},
    bufferedAmount: () => 0,
    userId,
  });
  await settle();
  return { handle, frames };
}

type ClientFrame = [event: string, payload: unknown, metadata?: unknown];

async function send(socket: OpenSocket, [event, payload, metadata]: ClientFrame) {
  await socket.handle.handleMessage(JSON.stringify([event, payload, metadata ?? null]));
  await settle();
}

function events(socket: OpenSocket): string[] {
  return socket.frames.map((frame) => frame[0]);
}

describe('plugin scope — every send surface is namespaced on a real engine', () => {
  const ph = server({
    scope: 'plugin',
    capabilities: [
      emits({ 'user-online': t<{ via: string }>() }),
      tags((ephemeral) => [ephemeral('room', t<string>())]),
    ],
  });
  const viaConnections = ph.on('via-connections', {
    run(ctx) {
      ctx.connections.get(ctx.connection).send('user-online', { via: 'connections' });
    },
  });
  const viaUsers = ph.on('via-users', {
    run(ctx) {
      ctx.users.get(ctx.user.id).broadcast('user-online', { via: 'users' });
      ctx.user.broadcast('user-online', { via: 'user' });
    },
  });
  const viaTags = ph.on('via-tags', {
    run(ctx) {
      const room = ctx.tags.ephemeral('room');
      room.add('lobby');
      room.broadcast('user-online', { via: 'tag-group' });
      room.ref('lobby').broadcast('user-online', { via: 'tag-ref' });
    },
  });
  const onlineChecks: boolean[] = [];

  const checkOnline = ph.on('check-online', {
    run(ctx) {
      onlineChecks.push(ctx.user.isOnline(), ctx.users.get(ctx.user.id).isOnline());
    },
  });
  const Presence = plugin('acme:presence', {
    definition: ph.assemble({ handlers: [viaConnections, viaUsers, viaTags, checkOnline] }),
  });

  async function openPresence() {
    const base = server({ capabilities: [Presence()] });
    const engine = buildEngine(base.assemble({ handlers: [] }));
    await engine.initialize();
    return open(engine, 'alice');
  }

  function onlineFrames(socket: OpenSocket) {
    return socket.frames.filter((frame) => frame[0] === '__acme:presence::user-online');
  }

  it('ctx.connections.get(ref).send goes out under the plugin namespace', async () => {
    const socket = await openPresence();
    await send(socket, ['__acme:presence::via-connections', {}]);

    expect(onlineFrames(socket).map((frame) => frame[1])).toEqual([{ via: 'connections' }]);
    expect(events(socket)).not.toContain('__error__');
  });

  it('ctx.users.get(id).broadcast and ctx.user.broadcast go out under the plugin namespace', async () => {
    const socket = await openPresence();
    await send(socket, ['__acme:presence::via-users', {}]);

    expect(onlineFrames(socket).map((frame) => frame[1])).toEqual([
      { via: 'users' },
      { via: 'user' },
    ]);
    expect(events(socket)).not.toContain('__error__');
  });

  it('ctx.user.isOnline and ctx.users.get(id).isOnline pass through the plugin scope', async () => {
    const socket = await openPresence();
    await send(socket, ['__acme:presence::check-online', {}]);

    expect(onlineChecks).toEqual([true, true]);
    expect(events(socket)).not.toContain('__error__');
  });

  it('tag group and tag ref broadcast go out under the plugin namespace', async () => {
    const socket = await openPresence();
    await send(socket, ['__acme:presence::via-tags', {}]);

    expect(onlineFrames(socket).map((frame) => frame[1])).toEqual([
      { via: 'tag-group' },
      { via: 'tag-ref' },
    ]);
    expect(events(socket)).not.toContain('__error__');
  });
});

describe('plugin onError — only the plugin’s own failures', () => {
  interface Seen {
    errors: (string | undefined)[];
    validation: string[];
  }

  function buildApp() {
    const probe: Seen = { errors: [], validation: [] };
    const app: Seen = { errors: [], validation: [] };

    const ph = server({
      scope: 'plugin',
      capabilities: [channels()],
      onError(_ctx, error, event) {
        probe.errors.push(event);
        if (ValidationFailed.matches(error)) probe.validation.push(event!);
      },
    });
    const fail = ph.on('fail', {
      run() {
        throw new Error('probe failed');
      },
    });
    const strict = ph.on('strict', { input: v.object({ n: v.number() }), run() {} });
    const room = ph.channel('room', {
      onSubscribe() {
        throw new Error('probe subscribe failed');
      },
    });

    const say = room.on('say', {
      run() {
        throw new Error('probe channel handler failed');
      },
    });
    const Probe = plugin('acme:probe', {
      definition: ph.assemble({ handlers: [fail, strict, room, say] }),
    });

    const other = server({ scope: 'plugin' });
    const otherFail = other.on('fail', {
      run() {
        throw new Error('other failed');
      },
    });
    const otherStrict = other.on('strict', { input: v.object({ n: v.number() }), run() {} });
    const Other = plugin('acme:other', {
      definition: other.assemble({ handlers: [otherFail, otherStrict] }),
    });

    const base = server({
      capabilities: [Probe(), Other()],
      onError(_ctx, error, event) {
        app.errors.push(event);
        if (ValidationFailed.matches(error)) app.validation.push(event!);
      },
    });
    const appFail = base.on('app-fail', {
      run() {
        throw new Error('app failed');
      },
    });
    const appStrict = base.on('app-strict', { input: v.object({ n: v.number() }), run() {} });

    const engine = buildEngine(base.assemble({ handlers: [appFail, appStrict] }));

    return { engine, probe, app };
  }

  it('skips app failures and other plugins’ failures', async () => {
    const { engine, probe, app } = buildApp();
    await engine.initialize();
    const socket = await open(engine, 'alice');

    await send(socket, ['app-fail', {}]);
    await send(socket, ['app-strict', { n: 'x' }]);
    await send(socket, ['__acme:other::fail', {}]);
    await send(socket, ['__acme:other::strict', { n: 'x' }]);

    expect(probe).toEqual({ errors: [], validation: [] });
    expect(app.errors).toEqual([
      'app-fail',
      'app-strict',
      '__acme:other::fail',
      '__acme:other::strict',
    ]);
    expect(app.validation).toEqual(['app-strict', '__acme:other::strict']);
  });

  it('runs for the plugin’s own handler failures, with the short event name', async () => {
    const { engine, probe, app } = buildApp();
    await engine.initialize();
    const socket = await open(engine, 'alice');

    await send(socket, ['__acme:probe::fail', {}]);
    await send(socket, ['__acme:probe::strict', { n: 'x' }]);

    expect(probe.errors).toEqual(['fail', 'strict']);
    expect(probe.validation).toEqual(['strict']);
    // The app still sees every failure, under the wire name.
    expect(app.errors).toEqual(['__acme:probe::fail', '__acme:probe::strict']);
    expect(app.validation).toEqual(['__acme:probe::strict']);
  });

  it('runs for failures on the plugin’s own channel', async () => {
    const { engine, probe } = buildApp();
    await engine.initialize();
    const socket = await open(engine, 'alice');
    const channel = { channel: { name: '__acme:probe::room' } };

    await send(socket, ['__subscribe__', null, channel]);
    expect(probe.errors).toEqual(['__subscribe__']);
  });

  it('runs for a failing handler inside the plugin’s channel', async () => {
    const { engine, probe } = buildApp();
    await engine.initialize();
    const alice = await open(engine, 'alice');
    const channel = { channel: { name: '__acme:probe::room' } };

    // The subscribe hook throws, so the member is rejected; send on the
    // channel anyway and check the membership error is also the plugin's.
    await send(alice, ['__subscribe__', null, channel]);
    await send(alice, ['__acme:probe::say', {}, channel]);

    expect(probe.errors).toEqual(['__subscribe__', 'say']);
  });
});
