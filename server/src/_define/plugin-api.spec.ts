import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { emits } from '~/emits/emits.ts';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

type Frame = [string, Record<string, unknown> | null, Record<string, unknown> | null];

interface PollsApi {
  createPoll(question: string): string;
  ctxKeys(): string[];
}

interface HostAdmin {
  plugin(id: 'acme:polls'): PollsApi;
  plugin(id: string): unknown;
  closeEverything(): string;
}

function buildEngine() {
  const factoryRuns = vi.fn();
  const scoped = server({
    scope: 'plugin',
    capabilities: [emits({ 'poll-created': t<{ id: string; question: string }>() })],
  });
  const Polls = plugin('acme:polls', {
    definition: scoped.assemble({
      handlers: [],
      api: (ctx) => {
        factoryRuns();
        let next = 0;
        return {
          createPoll(question: string) {
            next += 1;
            const id = `p_${next}`;
            ctx.broadcast('poll-created', { id, question });
            return id;
          },
          ctxKeys: () => Object.keys(ctx),
        };
      },
    }),
  });

  const base = server({
    authenticate: () => ({}),
    capabilities: [emits({ 'poll-made': t<{ id: string }>() }), Polls()],
  });
  const makePoll = base.on('make-poll', {
    input: v.object({ question: v.string() }),
    run(ctx, input) {
      ctx.send('poll-made', { id: ctx.plugin('acme:polls').createPoll(input.question) });
    },
  });

  let engine!: Engine;
  adapter({
    id: 'plugin-api-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(
    base.assemble({
      handlers: [makePoll],
      api: (ctx) => ({
        closeEverything: () => ctx.plugin('acme:polls').createPoll('Close everything?'),
      }),
    }),
    undefined as never,
  );

  return { engine, factoryRuns, admin: () => engine.admin() as unknown as HostAdmin };
}

async function connect(engine: Engine, userId: string) {
  const frames: Frame[] = [];
  const handle = engine.accept(Symbol(userId), {
    send(frame: { kind: string; text?: string }) {
      if (frame.kind === 'text') frames.push(JSON.parse(frame.text!) as Frame);
    },
    close: () => {},
    bufferedAmount: () => 0,
    userId,
    meta: {},
  });
  await vi.advanceTimersByTimeAsync(0);

  return {
    of: (event: string) => frames.filter(([name]) => name === event).map(([, payload]) => payload),
    async send(event: string, payload: unknown) {
      await handle.handleMessage(JSON.stringify([event, payload, null]));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a plugin's api is connectionless", () => {
  it('gets a ctx with no connection in it', async () => {
    const { engine, admin } = buildEngine();
    await engine.initialize();

    const keys = admin().plugin('acme:polls').ctxKeys();
    expect(keys).toContain('broadcast');
    expect(keys).not.toContain('connection');
    expect(keys).not.toContain('send');
  });

  it('builds the api once, for every handler and for admin', async () => {
    const { engine, factoryRuns, admin } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');

    await alice.send('make-poll', { question: 'Lunch?' });
    await bob.send('make-poll', { question: 'Dinner?' });

    expect(alice.of('poll-made')).toEqual([{ id: 'p_1' }]);
    expect(bob.of('poll-made')).toEqual([{ id: 'p_2' }]);
    expect(admin().plugin('acme:polls').createPoll('Breakfast?')).toBe('p_3');
    expect(factoryRuns).toHaveBeenCalledTimes(1);
  });

  it("sends the api's broadcast under the plugin's prefix, from admin too", async () => {
    const { engine, admin } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');

    admin().plugin('acme:polls').createPoll('Lunch?');
    await vi.advanceTimersByTimeAsync(0);

    expect(alice.of('__acme:polls::poll-created')).toEqual([{ id: 'p_1', question: 'Lunch?' }]);
  });

  it("lets the host's own api reach a plugin", async () => {
    const { engine, admin } = buildEngine();
    await engine.initialize();

    expect(admin().closeEverything()).toBe('p_1');
  });

  it('names the plugins when api factories call each other while they build', async () => {
    const pingBase = server({ scope: 'plugin', capabilities: [] });
    const pongBase = server({ scope: 'plugin', capabilities: [] });
    const Ping = plugin('acme:ping', {
      definition: pingBase.assemble({
        handlers: [],
        api: (ctx) => ({ pong: (ctx as unknown as HostAdmin).plugin('acme:pong') }),
      }),
    });
    const Pong = plugin('acme:pong', {
      definition: pongBase.assemble({
        handlers: [],
        api: (ctx) => ({ ping: (ctx as unknown as HostAdmin).plugin('acme:ping') }),
      }),
    });
    let engine!: Engine;

    adapter({
      id: 'plugin-api-cycle-spec',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        engine = createEngine({
          storage: createTestStorage(),
          timers: createTestTimers(),
          platform: {},
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        return {};
      },
    })(server({ capabilities: [Ping(), Pong()] }).assemble({ handlers: [] }), undefined as never);
    await engine.initialize();

    const admin = engine.admin() as unknown as HostAdmin;
    expect(() => admin.plugin('acme:ping')).toThrow(
      "plugin('acme:ping') is used while its own api is being built: acme:ping → acme:pong → acme:ping",
    );
    // Nothing half-built was kept, so the next call tells the same story.
    expect(() => admin.plugin('acme:pong')).toThrow(/acme:pong → acme:ping → acme:pong/);
  });

  it('says so when a listed plugin has no api', async () => {
    const quietBase = server({ scope: 'plugin', capabilities: [] });
    const Quiet = plugin('acme:quiet', {
      definition: quietBase.assemble({ handlers: [] }),
    });
    let engine!: Engine;
    adapter({
      id: 'plugin-api-none-spec',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        engine = createEngine({
          storage: createTestStorage(),
          timers: createTestTimers(),
          platform: {},
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        return {};
      },
    })(server({ capabilities: [Quiet()] }).assemble({ handlers: [] }), undefined as never);
    await engine.initialize();

    expect(() => (engine.admin() as unknown as HostAdmin).plugin('acme:quiet')).toThrow(
      "plugin('acme:quiet') has no api. Pass an api to the plugin's assemble({ handlers, api }).",
    );
  });

  it('throws for a plugin that is not registered', async () => {
    const { engine, admin } = buildEngine();
    await engine.initialize();

    expect(() => admin().plugin('acme:nope')).toThrow(/no plugin with id 'acme:nope'/);
  });
});
