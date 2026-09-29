import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { resetCallContextForTests } from '~/_engine/call-context.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { scheduled } from '~/scheduled/capability.ts';
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

    expect(message).toMatch(/not the server definition running now/);
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

describe('context.channel and context.channelGate', () => {
  function setup() {
    const base = server({ capabilities: [channels()] });
    const lobby = base.channel('lobby', {});
    const other = base.channel('other', {});
    const seen: Record<string, unknown> = {};

    lobby.subscribe((ctx) => {
      seen.subscribe = context.channelGate(lobby) === ctx;
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

  it('returns the channel ctx in handlers and the gate ctx in hooks', async () => {
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
