import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { resetCallContextForTests } from '~/_engine/call-context.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { Defer } from '~/errors/errors.ts';
import { error as defineError } from '~/index.ts';
import { intercepts } from '~/intercept/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { context } from './ambient-context.ts';

beforeEach(() => {
  resetCallContextForTests();
});

function buildEngine(definition: ServerDefinition, platform: unknown = {}): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'ambient-context-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform,
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

function open(engine: Engine, userId: string) {
  return engine.accept(Symbol(userId), {
    send() {},
    close() {},
    bufferedAmount: () => 0,
    userId,
  } as never);
}

function frame(event: string, livething: unknown = null): string {
  return JSON.stringify([event, {}, livething]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('context.connection', () => {
  it('returns the ctx of the running handler, across await points', async () => {
    const base = server({ capabilities: [emits({ pong: t<{ ok: boolean }>() })] });
    const seen: { fromHandler?: unknown; fromHelper?: unknown } = {};

    async function helper() {
      await sleep(1);
      seen.fromHelper = context.connection(base);
    }

    const probe = base.on('probe', {
      async run(ctx) {
        seen.fromHandler = ctx;
        await helper();
      },
    });

    const engine = buildEngine(base.assemble({ handlers: [probe] }));
    await engine.initialize();
    await open(engine, 'alice').handleMessage(frame('probe'));

    expect(seen.fromHelper).toBeDefined();
    expect(seen.fromHelper).toBe(seen.fromHandler);
  });

  it('gives each of two interleaved handlers its own ctx', async () => {
    const base = server({});
    const users: string[] = [];
    const probe = base.on('probe', {
      allowInterleaving: true,
      async run(ctx) {
        await sleep(ctx.user.id === 'slow' ? 20 : 1);
        users.push(`${ctx.user.id}->${context.connection(base).user.id}`);
      },
    });

    const engine = buildEngine(base.assemble({ handlers: [probe] }));
    await engine.initialize();
    await Promise.all([
      open(engine, 'slow').handleMessage(frame('probe')),
      open(engine, 'fast').handleMessage(frame('probe')),
    ]);

    expect(users.sort()).toEqual(['fast->fast', 'slow->slow']);
  });

  it('works inside onConnect and onDisconnect', async () => {
    const base = server({});
    const seen: string[] = [];
    base.onConnect((ctx) => {
      seen.push(context.connection(base) === ctx ? 'connect' : 'wrong');
    });
    base.onDisconnect((ctx) => {
      seen.push(context.connection(base) === ctx ? 'disconnect' : 'wrong');
    });

    const engine = buildEngine(base.assemble({ handlers: [] }));
    await engine.initialize();
    const handle = open(engine, 'alice');
    await handle.handleMessage(frame('noop'));
    await handle.handleClose(1000, 'bye');

    expect(seen).toEqual(['connect', 'disconnect']);
  });

  it('throws outside an invocation', () => {
    const base = server({});
    expect(() => context.connection(base)).toThrow(/outside a LiveThing handler or hook/);
  });

  it('throws when the running code is another kind of invocation', async () => {
    const base = server({ capabilities: [scheduled({ tick: null })] });
    let message = '';
    const probe = base.on('probe', {
      run() {
        try {
          context.task(base);
        } catch (error) {
          message = (error as Error).message;
        }
      },
    });
    base.scheduled('tick', { run() {} });

    const engine = buildEngine(base.assemble({ handlers: [probe] }));
    await engine.initialize();
    await open(engine, 'alice').handleMessage(frame('probe'));

    expect(message).toMatch(/'connection' invocation/);
    expect(message).toMatch(/context\.connection\(\)/);
  });

  it('throws when given a base from another server definition', async () => {
    const base = server({});
    const other = server({});
    let message = '';
    const probe = base.on('probe', {
      run() {
        try {
          context.connection(other);
        } catch (error) {
          message = (error as Error).message;
        }
      },
    });

    const engine = buildEngine(base.assemble({ handlers: [probe] }));
    await engine.initialize();
    await open(engine, 'alice').handleMessage(frame('probe'));

    expect(message).toMatch(/not the one running now/);
  });

  it('throws once the engine runs with a passthrough async context', async () => {
    const base = server({});
    let message = '';
    const probe = base.on('probe', {
      run() {
        try {
          context.connection(base);
        } catch (error) {
          message = (error as Error).message;
        }
      },
    });
    let engine: Engine | undefined;
    adapter({
      id: 'passthrough-spec',
      asyncContextFactory: <TStore>() => ({
        run: <R>(_store: TStore, callback: () => R) => callback(),
        getStore: () => undefined,
      }),
      setup(createEngine) {
        engine = createEngine({
          storage: createTestStorage(),
          platform: {},
          timers: createTestTimers(),
          logger: { info() {}, warn() {}, error() {} },
        });
        return {};
      },
    })(base.assemble({ handlers: [probe] }), undefined as never);

    await engine!.initialize();
    await open(engine!, 'alice').handleMessage(frame('probe'));

    expect(message).toMatch(/outside a LiveThing handler or hook/);
  });
});

describe('context.init, context.shutdown and context.upgrade', () => {
  it('returns the ctx of onInit, onShutdown and upgrade', async () => {
    const platform = { name: 'spec' };
    const seen: Record<string, unknown> = {};
    const base = server({
      upgrade: (_request, upgradeCtx) => {
        seen.upgrade = context.upgrade(base) === upgradeCtx;
        return { userId: 'u1' };
      },
    });
    base.onInit((ctx) => {
      seen.init = context.init(base) === ctx;
    });
    base.onShutdown((ctx) => {
      seen.shutdown = context.shutdown(base) === ctx;
    });

    const engine = buildEngine(base.assemble({ handlers: [] }), platform);
    await engine.initialize();
    await engine.handleUpgrade(new Request('https://x/'));
    await engine.handleShutdown();

    expect(seen).toEqual({ init: true, upgrade: true, shutdown: true });
  });
});

describe('context.task', () => {
  it('returns the ctx of a scheduled task handler', async () => {
    const base = server({ capabilities: [scheduled({ tick: null })] });
    const seen: { same?: boolean } = {};
    base.scheduled('tick', {
      run(ctx) {
        seen.same = context.task(base) === ctx;
      },
    });
    const arm = base.on('arm', {
      run(ctx) {
        ctx.schedule('tick', { time: Date.now() - 1 });
      },
    });

    const engine = buildEngine(base.assemble({ handlers: [arm] }));
    await engine.initialize();
    await open(engine, 'alice').handleMessage(frame('arm'));
    await engine.handleAlarm();

    expect(seen.same).toBe(true);
  });
});

describe('context.channel, context.channelGate and context.channelLifecycle', () => {
  function setup() {
    const base = server({ capabilities: [channels()] });
    const lobby = base.channel('lobby', {});
    const other = base.channel('other', {});
    const seen: Record<string, unknown> = {};

    lobby.subscribe((ctx) => {
      seen.subscribe = context.channelLifecycle(lobby) === ctx;
    });
    const say = lobby.on('say', {
      run(ctx) {
        seen.handler = context.channel(lobby) === ctx;
        try {
          context.channel(other);
        } catch (error) {
          seen.wrongChannel = (error as Error).message;
        }

        try {
          context.connection(base);
        } catch (error) {
          seen.wrongKind = (error as Error).message;
        }
      },
    });

    return { base, lobby, say, seen };
  }

  it('returns the channel ctx in handlers and the lifecycle ctx in subscribe', async () => {
    const { base, lobby, say, seen } = setup();
    const engine = buildEngine(base.assemble({ handlers: [lobby, say] }));
    await engine.initialize();
    const handle = open(engine, 'alice');

    await handle.handleMessage(frame('__subscribe__', { channel: { name: 'lobby' } }));
    await handle.handleMessage(frame('say', { channel: { name: 'lobby' } }));

    expect(seen.subscribe).toBe(true);
    expect(seen.handler).toBe(true);
    expect(seen.wrongChannel).toMatch(/not the one running now \(running: 'lobby'\)/);
    expect(seen.wrongKind).toMatch(/'channel' invocation/);
  });

  it('gives check and commit the gate accessor and subscribe, unsubscribe and sessionEnd the lifecycle accessor', async () => {
    const base = server({ capabilities: [channels()] });
    const seen: Record<string, unknown> = {};
    // The hooks below run later, after `lobby` is assigned.
    let lobbyRef = undefined as unknown as Parameters<typeof context.channelGate>[0];
    const lobby = base.channel('lobby', {
      check(ctx) {
        seen.check = context.channelGate(lobbyRef) === ctx;
        try {
          context.channelLifecycle(lobbyRef);
        } catch (error) {
          seen.lifecycleInCheck = (error as Error).message;
        }
      },
      commit(ctx) {
        seen.commit = context.channelGate(lobbyRef) === ctx;
      },
    });
    lobbyRef = lobby;
    lobby.subscribe((ctx) => {
      seen.subscribe = context.channelLifecycle(lobby) === ctx;
      try {
        context.channelGate(lobby);
      } catch (error) {
        seen.gateInSubscribe = (error as Error).message;
      }
    });
    lobby.unsubscribe((ctx) => {
      seen.unsubscribe = context.channelLifecycle(lobby) === ctx;
    });

    lobby.sessionEnd((ctx) => {
      seen.sessionEnd = context.channelLifecycle(lobby) === ctx;
    });
    const engine = buildEngine(base.assemble({ handlers: [lobby] }));
    await engine.initialize();
    const handle = open(engine, 'alice');

    await handle.handleMessage(frame('__subscribe__', { channel: { name: 'lobby' } }));
    await handle.handleMessage(
      JSON.stringify([
        '__unsubscribe__',
        null,
        { channel: { name: 'lobby', unsubscribeId: 'u1' } },
      ]),
    );

    expect(seen).toMatchObject({
      check: true,
      commit: true,
      subscribe: true,
      unsubscribe: true,
      sessionEnd: true,
    });
    expect(seen.lifecycleInCheck).toMatch(/'channelGate' invocation[\s\S]*context\.channelGate/);
    expect(seen.gateInSubscribe).toMatch(
      /'channelLifecycle' invocation[\s\S]*context\.channelLifecycle/,
    );
  });

  it('reaches the top-level onError and onValidationError hooks for a channel event', async () => {
    const base = server({ capabilities: [channels()] });
    const lobby = base.channel('lobby', {});
    const boom = lobby.on('boom', {
      run() {
        throw new Error('boom');
      },
    });
    const typed = lobby.on('typed', { input: v.object({ n: v.number() }), run() {} });
    const seen: Record<string, unknown> = {};

    base.onError((ctx) => {
      seen.error = context.connection(base) === ctx;
    });
    base.onValidationError((ctx) => {
      seen.validation = context.connection(base) === ctx;
    });

    const engine = buildEngine(base.assemble({ handlers: [lobby, boom, typed] }));
    await engine.initialize();
    const handle = open(engine, 'alice');
    await handle.handleMessage(frame('__subscribe__', { channel: { name: 'lobby' } }));
    await handle.handleMessage(frame('boom', { channel: { name: 'lobby' } }));

    await handle.handleMessage(frame('typed', { channel: { name: 'lobby' } }));

    expect(seen).toEqual({ error: true, validation: true });
  });
});

describe('context in a stream handler', () => {
  it('reaches a plain run function that returns the generator, and the generator body', async () => {
    const base = server({ capabilities: [stream(), emits({ tick: t<{ n: number }>() })] });
    const seen: Record<string, unknown> = {};
    const feed = base.stream('feed', {
      run(ctx) {
        seen.beforeGenerator = context.connection(base) === ctx;
        return (async function* () {
          seen.insideGenerator = context.connection(base).user.id;
          yield { n: 1 };
        })();
      },
    });

    const engine = buildEngine(base.assemble({ handlers: [feed] }));
    await engine.initialize();
    await open(engine, 'alice').handleMessage(frame('feed', { stream: { id: 's1' } }));
    await sleep(10);

    expect(seen).toEqual({ beforeGenerator: true, insideGenerator: 'alice' });
  });
});

describe('context in the heartbeat hooks', () => {
  it('returns the connection ctx in onPing and onPong', async () => {
    const base = server({});
    const seen: Record<string, boolean> = {};
    base.onPing((ctx) => {
      seen.ping = context.connection(base) === ctx;
    });
    base.onPong((ctx) => {
      seen.pong = context.connection(base) === ctx;
    });
    const engine = buildEngine(base.assemble({ handlers: [] }));

    await engine.initialize();
    const handle = open(engine, 'alice');

    await handle.handleMessage('ping');
    await handle.handleMessage('pong');

    expect(seen).toEqual({ ping: true, pong: true });
  });
});

describe('context in the features of a channel', () => {
  const SUBSCRIBE = JSON.stringify(['__subscribe__', {}, { channel: { name: 'room' } }]);

  it('returns the channel ctx in a channel stream handler and its generator', async () => {
    const base = server({ capabilities: [channels(), stream()] });
    const seen: Record<string, boolean> = {};
    const room = base.channel('room', {});
    const feed = room.stream('feed', {
      input: v.object({}),
      chunk: t<{ n: number }>(),
      run(ctx) {
        seen.beforeGenerator = context.channel(room) === ctx;
        return (async function* () {
          seen.insideGenerator = context.channel(room).channel.name === 'room';
          yield { n: 1 };
        })();
      },
    });
    const engine = buildEngine(base.assemble({ handlers: [room, feed] }));

    await engine.initialize();
    const handle = open(engine, 'alice');

    await handle.handleMessage(SUBSCRIBE);
    await handle.handleMessage(
      JSON.stringify(['feed', {}, { channel: { name: 'room' }, stream: { id: 's1' } }]),
    );
    await sleep(10);

    expect(seen).toEqual({ beforeGenerator: true, insideGenerator: true });
  });

  it('returns the channel ctx in a channel recorded stream handler and its generator', async () => {
    const base = server({ capabilities: [channels(), recordedStream()] });
    const seen: Record<string, boolean> = {};
    const room = base.channel('room', {});
    const feed = room.recordedStream('feed', {
      input: v.object({}),
      chunk: t<{ n: number }>(),
      maxChunks: 10,
      run(ctx) {
        seen.beforeGenerator = context.channel(room) === ctx;
        return (async function* () {
          seen.insideGenerator = context.channel(room).channel.name === 'room';
          yield { n: 1 };
        })();
      },
    });
    const engine = buildEngine(base.assemble({ handlers: [room, feed] }));

    await engine.initialize();
    const handle = open(engine, 'alice');

    await handle.handleMessage(SUBSCRIBE);
    await handle.handleMessage(
      JSON.stringify(['feed', {}, { channel: { name: 'room' }, stream: { id: 's1' } }]),
    );
    await sleep(10);

    expect(seen).toEqual({ beforeGenerator: true, insideGenerator: true });
  });

  it('returns the channel ctx in a channel request handler', async () => {
    const base = server({ capabilities: [channels(), clientRequests()] });
    const seen: Record<string, boolean> = {};
    const room = base.channel('room', {});
    const info = room.request('info', {
      input: v.object({}),
      run(ctx) {
        seen.request = context.channel(room) === ctx;
        return { ok: true };
      },
    });
    const engine = buildEngine(base.assemble({ handlers: [room, info] }));

    await engine.initialize();
    const handle = open(engine, 'alice');

    await handle.handleMessage(SUBSCRIBE);
    await handle.handleMessage(
      JSON.stringify([
        'info',
        {},
        { channel: { name: 'room' }, exchange: { id: 'x1', source: 'client' } },
      ]),
    );

    expect(seen).toEqual({ request: true });
  });

  it('returns the channel ctx in a channel intercept and the connection ctx in a top-level one', async () => {
    const base = server({ capabilities: [channels(), intercepts()] });
    const seen: Record<string, boolean> = {};
    base.intercept((ctx) => {
      seen.topLevel = context.connection(base) === ctx;
    });
    const room = base.channel('room', {});
    room.intercept((ctx) => {
      seen.channel = context.channel(room) === ctx;
    });

    const say = room.on('say', { run() {} });
    const engine = buildEngine(base.assemble({ handlers: [room, say] }));
    await engine.initialize();
    const handle = open(engine, 'alice');

    await handle.handleMessage(SUBSCRIBE);
    await handle.handleMessage(frame('say', { channel: { name: 'room' } }));

    expect(seen).toEqual({ topLevel: true, channel: true });
  });
});

describe('context in the onError hook for a stream that throws', () => {
  async function runFailingStream(fail: () => never) {
    const base = server({ capabilities: [stream()] });
    const seen: Record<string, boolean> = {};
    base.onError((ctx) => {
      seen.onError = context.connection(base) === ctx;
    });
    const feed = base.stream('feed', {
      input: v.object({}),
      chunk: t<{ n: number }>(),
      async *run() {
        yield { n: 1 };
        fail();
      },
    });
    const engine = buildEngine(base.assemble({ handlers: [feed] }));

    await engine.initialize();

    await open(engine, 'alice').handleMessage(frame('feed', { stream: { id: 's1' } }));
    await sleep(20);

    return seen;
  }

  it('returns the connection ctx when the stream throws an error', async () => {
    const seen = await runFailingStream(() => {
      throw new Error('stream failed');
    });

    expect(seen).toEqual({ onError: true });
  });

  it('returns the connection ctx when the stream throws Defer, which a stream cannot retry', async () => {
    const seen = await runFailingStream(() => {
      throw Defer(10);
    });

    expect(seen).toEqual({ onError: true });
  });
});

describe('context inside onOutgoing', () => {
  it('has no context, so it cannot name the sender by mistake', async () => {
    const base = server({ capabilities: [emits({ note: t<{ n: number }>() })] });
    let message = '';
    base.onOutgoing(() => {
      try {
        context.connection(base);
      } catch (error) {
        message = (error as Error).message;
      }
    });
    const send = base.on('send', {
      run(ctx) {
        ctx.send('note', { n: 1 });
      },
    });

    const engine = buildEngine(base.assemble({ handlers: [send] }));
    await engine.initialize();
    await open(engine, 'alice').handleMessage(frame('send'));

    expect(message).toMatch(/outside a LiveThing handler or hook/);
  });
});

describe('a recorded stream chunk that does not stay an object in JSON', () => {
  it('is wrapped as { value }, a Date included, from one toJSON() call', async () => {
    let calls = 0;
    // A second toJSON() call would give a string; only one call may decide the chunk.
    const record = {
      toJSON() {
        calls += 1;
        return calls === 1 ? { id: 'm1' } : 'changed';
      },
    };

    const base = server({ capabilities: [recordedStream()] });
    const progress = base.recordedStream('progress', {
      chunk: t<number | Date | typeof record>(),
      maxChunks: 10,
      async *run() {
        yield 1;
        yield new Date(0);
        yield record;
      },
    });
    const engine = buildEngine(base.assemble({ handlers: [progress] }));
    await engine.initialize();

    const sent: string[] = [];

    const handle = engine.accept(Symbol('alice'), {
      send: (message: string) => sent.push(message),
      close() {},
      bufferedAmount: () => 0,
      userId: 'alice',
    } as never);

    await handle.handleMessage(frame('progress', { stream: { id: 's1' } }));
    await sleep(20);

    const chunks = sent
      .map((message) => JSON.parse(message) as [string, unknown])
      .filter(([event]) => event === 'progress')
      .map(([, payload]) => payload);
    expect(chunks).toEqual([{ value: 1 }, { value: '1970-01-01T00:00:00.000Z' }, { id: 'm1' }]);
    expect(calls).toBe(1);
  });
});

describe('a stream that yields a value that is not an object', () => {
  it('ends with internal-error and logs which stream broke the payload rule', async () => {
    const base = server({ capabilities: [stream()] });
    const feed = base.stream('feed', {
      async *run() {
        // The types refuse null; this checks the runtime refuses it too.
        yield null as never;
      },
    });
    const logged: unknown[][] = [];
    let engine: Engine | undefined;
    adapter({
      id: 'null-chunk',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        engine = createEngine({
          storage: createTestStorage(),
          platform: {},
          timers: createTestTimers(),
          logger: { info() {}, warn() {}, error: (...args: unknown[]) => logged.push(args) },
        });
        return {};
      },
    })(base.assemble({ handlers: [feed] }), undefined as never);

    await engine!.initialize();
    const sent: string[] = [];
    const handle = engine!.accept(Symbol('alice'), {
      send: (message: string) => sent.push(message),
      close() {},
      bufferedAmount: () => 0,
      userId: 'alice',
    } as never);

    await handle.handleMessage(frame('feed', { stream: { id: 's1' } }));
    await sleep(20);

    expect(sent.at(-1)).toMatch(/"code":"internal-error"/);
    const meta = logged[0]?.[1] as { error: Error } | undefined;
    expect(meta?.error.message).toBe(
      `[livething] The payload for "feed" must be a plain object, such as { text: 'hi' }, ` +
        'but it was null. A stream chunk is a payload too, so yield an object.',
    );
  });
});

describe('an async commit hook', () => {
  it('is rejected without leaving an unhandled rejection behind', async () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      async commit() {
        await sleep(1);
        throw new Error('room is full');
      },
    });
    const unhandled: unknown[] = [];
    function record(reason: unknown) {
      unhandled.push(reason);
    }

    process.on('unhandledRejection', record);
    try {
      const engine = buildEngine(base.assemble({ handlers: [room] }));
      await engine.initialize();
      await open(engine, 'alice').handleMessage(
        JSON.stringify(['__subscribe__', {}, { channel: { name: 'room' } }]),
      );
      await sleep(20);

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});

describe('context inside a plugin', () => {
  function rooms() {
    const h = server({
      scope: 'plugin',
      capabilities: [
        channels(),
        stream(),
        scheduled({ sweep: null }),
        emits({ tick: t<{ n: number }>() }),
      ],
    });
    const room = h.channel('room', {});
    const seen: Record<string, unknown> = {};
    function attempt(key: string, read: () => unknown, ctx: unknown) {
      try {
        seen[key] = read() === ctx;
      } catch (error) {
        seen[key] = (error as Error).message;
      }
    }

    room.subscribe((ctx) => attempt('lifecycle', () => context.channelLifecycle(room), ctx));
    const say = room.on('say', {
      run: (ctx) => attempt('channel', () => context.channel(room), ctx),
    });
    const hello = h.on('hello', {
      run(ctx) {
        attempt('connection', () => context.connection(h), ctx);
        ctx.schedule('sweep', { time: Date.now() - 1 });
      },
    });
    h.scheduled('sweep', { run: (ctx) => attempt('task', () => context.task(h), ctx) });
    const ticks = h.stream('ticks', {
      async *run(ctx) {
        await sleep(1);
        attempt('stream', () => context.connection(h), ctx);
        ctx.send('tick', { n: 1 });
        yield { n: 1 };
      },
    });

    const Rooms = plugin('acme:rooms', {
      definition: h.assemble({ handlers: [room, say, hello, ticks] }),
    });

    return { Rooms, seen };
  }

  it("returns the plugin's scoped ctx for the plugin's own base and channels", async () => {
    const { Rooms, seen } = rooms();
    const engine = buildEngine(server({ capabilities: [Rooms()] }).assemble({ handlers: [] }));
    await engine.initialize();
    const handle = open(engine, 'alice');
    const room = { channel: { name: '__acme:rooms::room' } };

    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, room]));
    await handle.handleMessage(JSON.stringify(['__acme:rooms::say', {}, room]));
    await handle.handleMessage(frame('__acme:rooms::hello'));
    await engine.handleAlarm();
    await handle.handleMessage(frame('__acme:rooms::ticks', { stream: { id: 's1' } }));

    await sleep(20);

    expect(seen).toEqual({
      lifecycle: true,
      channel: true,
      connection: true,
      task: true,
      stream: true,
    });
  });

  it("gives a plugin's stream the scoped ctx, so its sends carry the plugin prefix", async () => {
    const { Rooms } = rooms();
    const engine = buildEngine(server({ capabilities: [Rooms()] }).assemble({ handlers: [] }));
    await engine.initialize();
    const sent: string[] = [];
    const handle = engine.accept(Symbol('alice'), {
      send: (message: string) => sent.push(message),
      close() {},
      bufferedAmount: () => 0,
      userId: 'alice',
    } as never);

    await handle.handleMessage(frame('__acme:rooms::ticks', { stream: { id: 's1' } }));
    await sleep(20);

    expect(sent.filter((message) => message.includes('tick"'))).toEqual([
      expect.stringMatching(/^\["__acme:rooms::tick",\{"n":1\}/),
    ]);
  });

  it("returns the plugin's ctx in every plugin hook, and none in its outgoing hook", async () => {
    const h = server({
      scope: 'plugin',
      capabilities: [intercepts(), emits({ failing: t<{ reason: string }>() })],
    });
    const seen: Record<string, unknown> = {};
    function check(key: string, read: () => unknown, ctx: unknown) {
      try {
        seen[key] = read() === ctx;
      } catch (error) {
        seen[key] = (error as Error).message;
      }
    }

    h.onInit((ctx) => check('init', () => context.init(h), ctx));
    h.onConnect((ctx) => check('connect', () => context.connection(h), ctx));
    h.onPing((ctx) => check('ping', () => context.connection(h), ctx));
    h.onPong((ctx) => check('pong', () => context.connection(h), ctx));
    h.onError((ctx) => check('error', () => context.connection(h), ctx));

    h.onDisconnect((ctx) => check('disconnect', () => context.connection(h), ctx));
    h.onShutdown((ctx) => check('shutdown', () => context.shutdown(h), ctx));
    h.intercept((ctx) => check('intercept', () => context.connection(h), ctx));
    h.onOutgoing(() => check('outgoing', () => context.connection(h), undefined));
    const fail = h.on('fail', {
      run(ctx) {
        ctx.send('failing', { reason: 'on purpose' });
        throw new Error('failed on purpose');
      },
    });

    const Audit = plugin('acme:audit', { definition: h.assemble({ handlers: [fail] }) });

    const engine = buildEngine(server({ capabilities: [Audit()] }).assemble({ handlers: [] }));
    await engine.initialize();
    const handle = open(engine, 'alice');
    await handle.handleMessage('ping');
    await handle.handleMessage('pong');

    await handle.handleMessage(frame('__acme:audit::fail'));
    await handle.handleClose(1000, 'bye');
    await engine.handleShutdown();

    expect(seen).toEqual({
      init: true,
      connect: true,
      ping: true,
      pong: true,
      intercept: true,
      outgoing: expect.stringMatching(/outside a LiveThing handler or hook/),
      error: true,
      disconnect: true,
      shutdown: true,
    });
  });

  it("returns the plugin's scoped ctx for a channel family that the plugin declares", async () => {
    const h = server({ scope: 'plugin', capabilities: [channels()] });
    const rooms = h.channel(['rooms', 'room:{id}']);
    const seen: Record<string, unknown> = {};
    const say = rooms.on('say', {
      run(ctx) {
        seen.same = context.channel(rooms) === ctx;
        seen.id = ctx.channel.params.id;
      },
    });
    const Rooms = plugin('acme:rooms', { definition: h.assemble({ handlers: [rooms, say] }) });

    const engine = buildEngine(server({ capabilities: [Rooms()] }).assemble({ handlers: [] }));
    await engine.initialize();
    const handle = open(engine, 'alice');
    const room = { channel: { name: 'room:42', family: '__acme:rooms::rooms' } };
    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, room]));

    await handle.handleMessage(JSON.stringify(['__acme:rooms::say', {}, room]));

    expect(seen).toEqual({ same: true, id: '42' });
  });

  it("returns the plugin's scoped ctx in a plugin's recorded stream", async () => {
    const h = server({ scope: 'plugin', capabilities: [channels(), recordedStream()] });
    const room = h.channel('room', {});
    const seen: Record<string, unknown> = {};
    const feed = room.recordedStream('feed', {
      input: v.object({}),
      chunk: t<{ n: number }>(),
      maxChunks: 10,
      async *run(ctx) {
        await sleep(1);
        seen.same = context.channel(room) === ctx;
        yield { n: 1 };
      },
    });
    const Feeds = plugin('acme:feeds', { definition: h.assemble({ handlers: [room, feed] }) });

    const engine = buildEngine(server({ capabilities: [Feeds()] }).assemble({ handlers: [] }));
    await engine.initialize();
    const handle = open(engine, 'alice');
    const channel = { name: '__acme:feeds::room' };
    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, { channel }]));

    await handle.handleMessage(
      JSON.stringify(['__acme:feeds::feed', {}, { channel, stream: { id: 's1' } }]),
    );
    await sleep(20);

    expect(seen).toEqual({ same: true });
  });

  it("sends an error that a plugin's stream throws with the plugin's error code", async () => {
    const Denied = defineError('denied', v.object({ why: v.string() }));
    const h = server({ scope: 'plugin', capabilities: [stream(), errors([Denied])] });
    const feed = h.stream('feed', {
      async *run() {
        yield { joined: true };
        await sleep(1);
        throw Denied({ why: 'not a member' });
      },
    });
    const Feeds = plugin('acme:feeds', { definition: h.assemble({ handlers: [feed] }) });

    const engine = buildEngine(server({ capabilities: [Feeds()] }).assemble({ handlers: [] }));
    await engine.initialize();
    const sent: string[] = [];
    const handle = engine.accept(Symbol('alice'), {
      send: (message: string) => sent.push(message),
      close() {},
      bufferedAmount: () => 0,
      userId: 'alice',
    } as never);
    await handle.handleMessage(frame('__acme:feeds::feed', { stream: { id: 's1' } }));

    await sleep(20);

    const codes = sent.flatMap((message) => message.match(/"code":"[^"]*"/g) ?? []);
    expect(codes).toEqual(['"code":"__acme:feeds::denied"']);
  });

  it("runs a plugin's api methods as the app handler that calls them", async () => {
    const h = server({ scope: 'plugin' });
    const seen: Record<string, unknown> = {};
    const Audit = plugin('acme:audit', {
      definition: h.assemble({
        handlers: [],
        api: () => ({
          record() {
            seen.appBase = context.connection(app) === seen.appCtx;
            try {
              context.connection(h);
            } catch (error) {
              seen.pluginBase = (error as Error).message;
            }
          },
        }),
      }),
    });
    const app = server({ capabilities: [Audit()] });
    const save = app.on('save', {
      run(ctx) {
        seen.appCtx = ctx;
        ctx.plugin('acme:audit').record();
      },
    });

    const engine = buildEngine(app.assemble({ handlers: [save] }));
    await engine.initialize();
    await open(engine, 'alice').handleMessage(frame('save'));

    expect(seen.appBase).toBe(true);
    expect(seen.pluginBase).toMatch(/not the one running now/);
  });

  it("throws for the app's base inside plugin code", async () => {
    const h = server({ scope: 'plugin' });
    let message = '';
    const hello = h.on('hello', {
      run() {
        try {
          context.connection(app);
        } catch (error) {
          message = (error as Error).message;
        }
      },
    });
    const Greeter = plugin('acme:greeter', { definition: h.assemble({ handlers: [hello] }) });
    const app = server({ capabilities: [Greeter()] });

    const engine = buildEngine(app.assemble({ handlers: [] }));
    await engine.initialize();
    await open(engine, 'alice').handleMessage(frame('__acme:greeter::hello'));

    expect(message).toMatch(/a plugin's own base in that plugin's code/);
  });
});
