import { AsyncLocalStorage } from 'node:async_hooks';
import { LiveThingConfigError } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { readConnectionRow, writeConnectionRow } from '~/_engine/runtime/connection-store.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { awareness } from '~/awareness/capability.ts';
import { channels } from '~/channel/capability.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { emits } from '~/emits/emits.ts';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

type Frame = [string, Record<string, unknown> | null, Record<string, unknown> | null];
type Change = { connectionId: string; memberId?: string; meta?: unknown; state: unknown };

const viewing = v.object({ viewingMessageId: v.nullable(v.string()) });

interface Options {
  awareness?: Record<string, unknown>;
  presence?: boolean;
  messageLimits?: { receiveBytes: number; sendBytes: number; postBytes?: number };
  hibernation?: boolean;
  onError?: (
    ctx: { setMeta(patch: Record<string, unknown>): void },
    error: unknown,
  ) => Promise<void>;
}

function buildEngine(options: Options = {}) {
  const base = server({
    authenticate: () => ({}),
    ...(options.hibernation ? { hibernation: true } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    capabilities: [channels(), emits({ viewers: t<{ count: number }>() })],
  });

  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    ...(options.presence === undefined ? {} : { presence: options.presence }),
    capabilities: [awareness()],
    // Some tests pass a bad config on purpose to check the errors.
    awareness: { state: viewing, ...options.awareness } as { state: typeof viewing },
  });

  const countViewers = rooms.on('count-viewers', {
    run(ctx) {
      ctx.send('viewers', { count: ctx.channel.awareness.list().length });
    },
  });

  const mutateStates = rooms.on('mutate-states', {
    run(ctx) {
      for (const entry of ctx.channel.awareness.list()) entry.state.viewingMessageId = 'changed';
      const changed = ctx.channel.awareness
        .list()
        .filter((entry) => entry.state.viewingMessageId === 'changed');
      ctx.send('viewers', { count: changed.length });
    },
  });

  const clearOwnPlace = rooms.on('clear-own-place', {
    run(ctx) {
      ctx.channel.awareness.set(ctx.connection.id, { viewingMessageId: null });
    },
  });

  const clearOthers = rooms.on('clear-others', {
    run(ctx) {
      for (const entry of ctx.channel.awareness.list()) {
        if (entry.connectionId !== ctx.connection.id) {
          ctx.channel.awareness.set(entry.connectionId, null);
        }
      }
    },
  });

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const storage = createTestStorage();
  const persist = vi.fn();
  let engine!: Engine;
  adapter({
    id: 'awareness-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    ...(options.hibernation
      ? {
          hibernation: {
            persist,
            restore: (socket: unknown) => ({ id: (socket as { id: string }).id }),
          },
        }
      : {}),
    setup(createEngine) {
      engine = createEngine({
        storage,
        timers: createTestTimers(),
        platform: {},
        logger,
        ...(options.messageLimits ? { messageLimits: options.messageLimits } : {}),
      });
      return {};
    },
  })(
    base.assemble({ handlers: [countViewers, clearOthers, clearOwnPlace, mutateStates] }),
    undefined as never,
  );

  return { engine, logger, storage, persist };
}

const general = { channel: { name: 'room:general', family: 'rooms' } };
const random = { channel: { name: 'room:random', family: 'rooms' } };

async function connect(engine: Engine, userId: string) {
  const frames: Frame[] = [];
  let connectionId = '';
  const handle = engine.accept(Symbol(userId), {
    send(frame: { kind: string; text?: string }) {
      if (frame.kind !== 'text') return;

      const parsed = JSON.parse(frame.text!) as Frame;
      if (parsed[0] === '__connected__') connectionId = parsed[1]!.connectionId as string;
      frames.push(parsed);
    },
    close: () => {},
    bufferedAmount: () => 0,
    userId,
    meta: { name: userId, role: userId === 'guest' ? 'guest' : 'member' },
    // Ignored unless the engine was built with `hibernation`.
    survivesHibernation: true,
  });
  await vi.advanceTimersByTimeAsync(0);

  async function raw(frame: unknown): Promise<void> {
    await handle.handleMessage(JSON.stringify(frame));
    await vi.advanceTimersByTimeAsync(0);
  }

  return {
    get id() {
      return connectionId;
    },
    frames,
    raw,
    of: (event: string) => frames.filter(([name]) => name === event),
    changes: (): Change[] =>
      frames
        .filter(([event]) => event === '__awareness__')
        .flatMap(([, payload]) => payload!.changes as Change[]),
    refusals: () =>
      frames
        .filter(
          ([event, payload]) => event === '__error__' && payload!.code === 'awareness-refused',
        )
        .map(([, payload]) => (payload!.detail as { reason: string }).reason),
    subscribe: (to = general) => raw(['__subscribe__', null, to]),
    unsubscribe: (to = general) => raw(['__unsubscribe__', null, to]),
    set: (state: unknown, to = general) => raw(['__awarenessSet__', { state }, to]),
    send: (event: string, to = general) => raw([event, null, to]),
  };
}

/** Let every open window end. */
async function quiet(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('awareness config', () => {
  it.each([
    [{ presence: false }, /presence/],
    [{ awareness: { state: undefined } }, /state/],
    [{ awareness: { windowMs: 0 } }, /windowMs/],
    [{ awareness: { windowMs: 10_001 } }, /windowMs/],
    [{ awareness: { maxBytes: 65_537 } }, /maxBytes/],
    [{ awareness: { maxBytes: 1.5 } }, /maxBytes/],
    [{ awareness: { onChange: () => {} } }, /onChange/],
  ])('refuses %j', async (options, message) => {
    async function build() {
      const { engine } = buildEngine(options as Options);
      await engine.initialize();
    }

    await expect(build()).rejects.toThrow(LiveThingConfigError);
    await expect(build()).rejects.toThrow(message);
  });

  it('refuses awareness() in the server capabilities', () => {
    const base = server({
      capabilities: [channels(), awareness() as never],
    });

    expect(() => base.assemble({ handlers: [] })).toThrow(/awareness\(\) is channel-only/);
  });

  it('refuses awareness() on a plugin channel', async () => {
    const scoped = server({ scope: 'plugin', capabilities: [channels()] });
    const feed = scoped.channel('feed', {
      capabilities: [awareness()],
      awareness: { state: viewing },
    });
    const ping = feed.on('ping', { run() {} });
    const Feed = plugin('acme:feed', { definition: scoped.assemble({ handlers: [ping] }) });
    const base = server({ capabilities: [channels(), Feed()] });

    let engine!: Engine;
    adapter({
      id: 'awareness-plugin-spec',
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
    })(base.assemble({ handlers: [] }), undefined as never);

    await expect(engine.initialize()).rejects.toThrow(/is for app channels/);
  });

  it('refuses two awareness() in one channel', () => {
    const base = server({ capabilities: [channels()] });

    expect(() =>
      base.channel('lobby', {
        capabilities: [awareness(), awareness()],
        awareness: { state: viewing },
      } as never),
    ).toThrow(/more than once/);
  });

  it('refuses the awareness option without awareness() in the capabilities', () => {
    const base = server({ capabilities: [channels()] });

    expect(() => base.channel('lobby', { awareness: { state: viewing } } as never)).toThrow(
      /channel 'lobby': the 'awareness' option needs awareness\(\) in the channel's capabilities/,
    );
  });

  it('refuses awareness() without the awareness option', () => {
    const base = server({ capabilities: [channels()] });

    expect(() => base.channel('lobby', { capabilities: [awareness()] } as never)).toThrow(
      /channel 'lobby': awareness\(\) needs the channel's 'awareness' option/,
    );
  });

  it.each([
    [{ receiveBytes: 4096 + 1023, sendBytes: 1 << 20 }, /receive limit/],
    [{ receiveBytes: 1 << 20, sendBytes: 2 * (4096 + 1023) }, /half of its send limit/],
    [{ receiveBytes: 1 << 20, sendBytes: 1 << 20, postBytes: 4096 + 1024 + 4 }, /maxPostBytes/],
  ])('refuses a maxBytes that does not fit the limits %j', async (messageLimits, message) => {
    async function build() {
      const { engine } = buildEngine({ messageLimits });
      await engine.initialize();
    }

    await expect(build()).rejects.toThrow(message);
  });
});

describe('awareness', () => {
  it('tells the joiner the limit and sends it the states already there', async () => {
    const { engine } = buildEngine({ awareness: { maxBytes: 512 } });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');

    await alice.subscribe();
    await alice.set({ viewingMessageId: 'm1' });
    await quiet();
    await bob.subscribe();

    expect(bob.frames.map(([event]) => event).slice(1)).toEqual([
      '__subscribeOk__',
      '__memberSync__',
      '__awarenessSync__',
    ]);
    expect(bob.of('__subscribeOk__')[0]![2]!.channel).toEqual({
      name: 'room:general',
      family: 'rooms',
      membership: 'ephemeral',
      awareness: { maxBytes: 512 },
    });
    expect(bob.of('__awarenessSync__')[0]![1]).toEqual({
      entries: [
        {
          connectionId: alice.id,
          memberId: alice.id,
          meta: { name: 'alice', role: 'member' },
          state: { viewingMessageId: 'm1' },
          ageMs: 5000,
        },
      ],
    });
  });

  it('sends the first change at once, with meta, to everyone in the channel', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.subscribe();

    await bob.subscribe();
    await quiet();

    await alice.set({ viewingMessageId: 'm1' });

    const appeared = {
      connectionId: alice.id,
      memberId: alice.id,
      meta: { name: 'alice', role: 'member' },
      state: { viewingMessageId: 'm1' },
    };

    expect(bob.changes()).toEqual([appeared]);
    expect(alice.changes()).toEqual([appeared]);
  });

  it('keeps only the newest update of a window, and sends known entries without meta', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.subscribe();

    await bob.subscribe();
    await quiet();

    await alice.set({ viewingMessageId: 'm1' });
    await alice.set({ viewingMessageId: 'm2' });
    await alice.set({ viewingMessageId: 'm3' });
    expect(bob.changes()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);

    expect(bob.changes()[1]).toEqual({
      connectionId: alice.id,
      memberId: alice.id,
      state: { viewingMessageId: 'm3' },
    });
    expect(bob.changes()).toHaveLength(2);
  });

  it('drops an update that changes nothing', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();
    await alice.set({ viewingMessageId: 'm1' });

    await quiet();

    await alice.set({ viewingMessageId: 'm1' });
    await quiet();

    expect(alice.changes()).toHaveLength(1);
  });

  it.each([
    ['too-large', { viewingMessageId: 'x'.repeat(100) }, { maxBytes: 64 }],
    ['invalid', { viewingMessageId: 5 }, {}],
    // The types refuse this schema; plain JS can still pass one.
    [
      'invalid',
      { viewingMessageId: 'm1' },
      {
        state: v.pipe(
          viewing,
          v.transform(() => new Date(0)),
        ),
      },
    ],
    ['check', { viewingMessageId: 'm1' }, { check: () => false }],
    [
      'error',
      { viewingMessageId: 'm1' },
      {
        check: () => {
          throw new Error('check broke');
        },
      },
    ],
  ])('refuses with %s', async (reason, state, options) => {
    const { engine } = buildEngine({ awareness: options });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();

    await alice.set(state);
    await quiet();

    expect(alice.refusals()).toEqual([reason]);
    expect(alice.changes()).toEqual([]);
    const refusal = alice.frames.find(([event]) => event === '__error__')!;
    expect(refusal[2]).toEqual(general);
  });

  it('passes the sender ctx, the state and the previous state to check', async () => {
    const check = vi.fn(
      (ctx: { meta: { role: string } }, _state: unknown, _previous: unknown) =>
        ctx.meta.role !== 'guest',
    );
    const { engine } = buildEngine({ awareness: { check } });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const guest = await connect(engine, 'guest');

    await alice.subscribe();
    await guest.subscribe();

    await alice.set({ viewingMessageId: 'm1' });
    await quiet();
    await alice.set({ viewingMessageId: 'm2' });
    await guest.set({ viewingMessageId: 'm1' });
    await quiet();

    expect(check.mock.calls.map(([, state, previous]) => [state, previous])).toEqual([
      [{ viewingMessageId: 'm1' }, null],
      [{ viewingMessageId: 'm2' }, { viewingMessageId: 'm1' }],
      [{ viewingMessageId: 'm1' }, null],
    ]);
    expect(guest.refusals()).toEqual(['check']);
  });

  it('clears a state with null and when the connection leaves', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.subscribe();

    await bob.subscribe();
    await alice.set({ viewingMessageId: 'm1' });
    await bob.set({ viewingMessageId: 'm2' });
    await quiet();

    await alice.set(null);
    await quiet();
    await bob.unsubscribe();
    await quiet();

    expect(alice.changes().slice(-2)).toEqual([
      { connectionId: alice.id, state: null },
      { connectionId: bob.id, state: null },
    ]);
  });

  it('drops an update that was waiting when its sender left', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.subscribe();

    await bob.subscribe();
    await alice.set({ viewingMessageId: 'm1' });

    await alice.set({ viewingMessageId: 'm2' });
    await alice.unsubscribe();
    await quiet();
    await bob.send('count-viewers');

    expect(bob.of('viewers').at(-1)![1]).toEqual({ count: 0 });
    expect(bob.changes().at(-1)).toEqual({ connectionId: alice.id, state: null });
  });

  it('keeps separate states for two rooms of one family', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe(general);
    await alice.subscribe(random);

    await alice.set({ viewingMessageId: 'm1' }, general);
    await alice.set({ viewingMessageId: 'm9' }, random);
    await quiet();
    await alice.send('count-viewers', general);

    expect(alice.of('viewers').at(-1)![1]).toEqual({ count: 1 });
    expect(alice.changes().map((change) => change.state)).toEqual([
      { viewingMessageId: 'm1' },
      { viewingMessageId: 'm9' },
    ]);
  });

  it('gives a member who joined during a window only the changes after its sync', async () => {
    const { engine } = buildEngine({ awareness: { windowMs: 200 } });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.subscribe();

    await alice.set({ viewingMessageId: 'm1' });

    await alice.set({ viewingMessageId: 'm2' });
    await bob.subscribe();
    await alice.set({ viewingMessageId: 'm3' });
    await vi.advanceTimersByTimeAsync(200);

    expect(bob.of('__awarenessSync__')[0]![1]!.entries).toEqual([
      expect.objectContaining({ state: { viewingMessageId: 'm1' } }),
    ]);
    expect(bob.changes()).toEqual([
      { connectionId: alice.id, memberId: alice.id, state: { viewingMessageId: 'm3' } },
    ]);
  });

  it('lets a handler clear another connection, and that connection sees it', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.subscribe();

    await bob.subscribe();
    await bob.set({ viewingMessageId: 'm2' });
    await quiet();

    await alice.send('clear-others');
    await quiet();

    expect(bob.changes().at(-1)).toEqual({ connectionId: bob.id, state: null });
  });

  it('ignores a non-member and refuses a channel without awareness', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');

    await alice.set({ viewingMessageId: 'm1' });
    await quiet();
    expect(alice.of('__error__')).toEqual([]);
  });

  it('drops a frame larger than any channel allows before parsing it, and refuses one just over', async () => {
    const { engine, logger } = buildEngine({ awareness: { maxBytes: 64 } });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();

    await alice.set({ viewingMessageId: 'x'.repeat(5000) });
    await alice.set({ viewingMessageId: 'x'.repeat(100) });
    await quiet();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('__awarenessSet__ frame over every channel limit'),
      expect.anything(),
    );
    expect(alice.refusals()).toEqual(['too-large']);
  });

  it('sends a large sync in pieces, each with whole entries', async () => {
    const { engine } = buildEngine({
      awareness: { maxBytes: 64 },
      messageLimits: { receiveBytes: 1 << 20, sendBytes: 2 * (4096 + 200) },
    });
    await engine.initialize();
    const members = [];
    for (const name of ['alice', 'bob', 'carol']) {
      const member = await connect(engine, name);
      await member.subscribe();
      await member.set({ viewingMessageId: `m-${name}` });
      members.push(member);
    }

    await quiet();
    const dave = await connect(engine, 'dave');
    await dave.subscribe();

    const syncs = dave.of('__awarenessSync__').map(([, payload]) => payload!);
    expect(syncs.map((sync) => [(sync.entries as unknown[]).length, sync.more])).toEqual([
      [1, true],
      [1, true],
      [1, undefined],
    ]);
  });

  it('drops an update when check kicks its own sender', async () => {
    const kicks: Promise<void>[] = [];
    const { engine, logger } = buildEngine({
      awareness: {
        check: (ctx: {
          user: { ref(): unknown };
          channel: { kick(ref: unknown, opts: { reason: string }): Promise<void> };
        }) => {
          kicks.push(ctx.channel.kick(ctx.user.ref(), { reason: 'spam' }));
          return true;
        },
      },
    });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');

    await alice.subscribe();
    await bob.subscribe();

    await alice.set({ viewingMessageId: 'm1' });
    await quiet();
    await bob.send('count-viewers');

    await Promise.all(kicks);
    expect(logger.error.mock.calls).toEqual([]);
    expect(kicks).toHaveLength(1);
    expect(alice.of('__kicked__')).toHaveLength(1);
    expect(bob.of('viewers').at(-1)![1]).toEqual({ count: 0 });
  });

  it('runs check at most once per window, refused updates included', async () => {
    let calls = 0;
    const { engine } = buildEngine({
      awareness: {
        check: (_ctx: unknown, state: { viewingMessageId: string | null }) => {
          calls += 1;
          return state.viewingMessageId !== 'bad';
        },
      },
    });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();

    for (let i = 0; i < 20; i++) await alice.set({ viewingMessageId: 'bad' });
    await quiet();

    expect(calls).toBe(2);
    expect(alice.refusals()).toEqual(['check', 'check']);
  });

  it('counts stored awareness per connection in UTF-8 bytes', async () => {
    const { engine } = buildEngine({
      awareness: { maxBytes: 65_536 },
      messageLimits: { receiveBytes: 1 << 20, sendBytes: 1 << 20 },
    });
    await engine.initialize();
    const alice = await connect(engine, 'alice');

    // Each state is about 63,000 UTF-8 bytes but only 21,000 UTF-16 units.
    for (let i = 0; i < 20; i++) {
      const room = { channel: { name: `room:r${i}`, family: 'rooms' } };
      await alice.subscribe(room);
      await alice.set({ viewingMessageId: '€'.repeat(21_000) }, room);
    }

    expect(alice.refusals()).toEqual(['too-large', 'too-large', 'too-large', 'too-large']);
  });

  it('logs that a thrown check refused the update, not that the client got internal-error', async () => {
    const { engine, logger } = buildEngine({
      awareness: {
        check: () => {
          throw new Error('check failed');
        },
      },
    });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();

    await alice.set({ viewingMessageId: 'm1' });

    expect(alice.refusals()).toEqual(['error']);
    const messages = logger.error.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes('awareness-refused'))).toBe(true);
    expect(messages.some((message) => message.includes('internal-error'))).toBe(false);
  });

  describe.each([
    ['an error', new TypeError('schema broke')],
    ['undefined', undefined],
  ])('a state schema that throws %s', (_, thrown) => {
    const throwingState = v.pipe(
      viewing,
      v.check(() => {
        throw thrown;
      }),
    );
    function errorsOf(onError: ReturnType<typeof vi.fn>): unknown[] {
      return onError.mock.calls.map(([, error]) => error);
    }

    it('refuses a client update with error and gives what it threw to onError', async () => {
      const onError = vi.fn(async () => {});
      const { engine } = buildEngine({ awareness: { state: throwingState }, onError });
      await engine.initialize();
      const alice = await connect(engine, 'alice');
      await alice.subscribe();

      await alice.set({ viewingMessageId: 'm1' });
      await quiet();

      expect(alice.refusals()).toEqual(['error']);
      expect(errorsOf(onError)).toEqual([thrown]);
    });

    it('makes a server set() throw what it threw', async () => {
      const onError = vi.fn(async () => {});
      const { engine } = buildEngine({ awareness: { state: throwingState }, onError });
      await engine.initialize();
      const alice = await connect(engine, 'alice');
      await alice.subscribe();

      await alice.send('clear-own-place');

      expect(errorsOf(onError)).toEqual([thrown]);
    });
  });

  it('gives handlers a copy of each state, so changing it changes nothing stored', async () => {
    const { engine } = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();
    await alice.set({ viewingMessageId: 'm1' });

    await alice.send('mutate-states');

    expect(alice.of('viewers').at(-1)![1]).toEqual({ count: 0 });
  });
});

describe('awareness and hibernation', () => {
  const generalKey = createChannelMembershipKey('room:general', 'rooms');
  const randomKey = createChannelMembershipKey('room:random', 'rooms');

  /** A socket the platform kept while the server slept. */
  function sleepingSocket(id: string, options: { failSend?: boolean } = {}) {
    const frames: Frame[] = [];
    return {
      id,
      frames,
      send(data: string) {
        if (options.failSend) throw new Error('socket gone');

        frames.push(JSON.parse(data) as Frame);
      },
      close() {},
      changes: () =>
        frames
          .filter(([event]) => event === '__awareness__')
          .flatMap(([, payload]) => payload!.changes as Change[]),
    };
  }

  function sleepingRow(
    id: string,
    states: Record<string, unknown>,
    activeStreamIds: string[] = [],
  ) {
    return {
      connection_id: id,
      user_id: id,
      meta: { name: id },
      ephemeral_tags: [],
      ephemeral_memberships: [{ channelName: 'room:general', channelFamily: 'rooms' }],
      active_stream_ids: activeStreamIds,
      awareness: states as never,
    };
  }

  const kofiViewing = {
    state: '{"viewingMessageId":"m1"}',
    meta: '{"name":"kofi"}',
    updatedAt: 1,
  };

  it('leaves no write timer after a leave that follows a clear', async () => {
    const { engine } = buildEngine({ hibernation: true });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();
    await vi.advanceTimersByTimeAsync(200);

    const before = vi.getTimerCount();
    await alice.set({ viewingMessageId: 'm1' });
    await alice.set(null);
    await vi.advanceTimersByTimeAsync(200);

    await alice.unsubscribe();

    expect(vi.getTimerCount()).toBe(before);
  });

  it('leaves no write timer after a leave, which writes the row itself', async () => {
    const { engine, storage } = buildEngine({ hibernation: true });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();
    await vi.advanceTimersByTimeAsync(200);

    const before = vi.getTimerCount();
    await alice.set({ viewingMessageId: 'm1' });

    await alice.unsubscribe();
    await vi.advanceTimersByTimeAsync(200);

    // A pending timer would keep a Durable Object awake for nothing.
    expect(vi.getTimerCount()).toBe(before);
    expect(readConnectionRow(storage.sql, alice.id)?.awareness).toEqual({});
  });

  it('writes the row 5 s after a change, once for several changes', async () => {
    const { engine, storage, persist } = buildEngine({ hibernation: true });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();
    const writes = persist.mock.calls.length;

    await alice.set({ viewingMessageId: 'm1' });
    await vi.advanceTimersByTimeAsync(200);
    await alice.set({ viewingMessageId: 'm2' });
    await vi.advanceTimersByTimeAsync(4700);
    expect(readConnectionRow(storage.sql, alice.id)?.awareness).toEqual({});

    expect(persist.mock.calls.length).toBe(writes);

    await vi.advanceTimersByTimeAsync(100);
    expect(readConnectionRow(storage.sql, alice.id)?.awareness).toEqual({
      [generalKey]: {
        state: '{"viewingMessageId":"m2"}',
        meta: '{"name":"alice","role":"member"}',
        updatedAt: expect.any(Number),
      },
    });
    expect(persist.mock.calls.length).toBe(writes + 1);

    await quiet();
    expect(persist.mock.calls.length).toBe(writes + 1);
  });

  it('writes the row when an onError hook awaits and then calls setMeta', async () => {
    const { engine, storage } = buildEngine({
      hibernation: true,
      awareness: {
        check: () => {
          throw new Error('check failed');
        },
      },
      onError: async (ctx) => {
        await Promise.resolve();
        ctx.setMeta({ name: 'renamed' });
      },
    });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    await alice.subscribe();

    await alice.set({ viewingMessageId: 'm1' });

    expect(alice.refusals()).toEqual(['error']);
    expect(readConnectionRow(storage.sql, alice.id)?.meta).toEqual({
      name: 'renamed',
      role: 'member',
    });
  });

  it('brings back the states of a woken connection, already announced', async () => {
    const { engine, storage } = buildEngine({ hibernation: true });
    await engine.initialize();
    // `room:random` is a channel kofi had left: its state must not come back.
    writeConnectionRow(
      storage.sql,
      sleepingRow('kofi', { [generalKey]: kofiViewing, [randomKey]: kofiViewing }),
    );
    const kofi = sleepingSocket('kofi');
    await engine.restoreHibernatedConnections([kofi]);

    const dave = await connect(engine, 'dave');
    await dave.subscribe();
    await dave.subscribe(random);
    expect(dave.of('__awarenessSync__').map(([, payload]) => payload)).toEqual([
      {
        entries: [
          {
            connectionId: 'kofi',
            memberId: 'kofi',
            meta: { name: 'kofi' },
            state: { viewingMessageId: 'm1' },
            ageMs: expect.any(Number),
          },
        ],
      },
      { entries: [] },
    ]);

    await engine
      .handleHibernationWake(kofi)
      .handleMessage(
        JSON.stringify(['__awarenessSet__', { state: { viewingMessageId: 'm2' } }, general]),
      );
    await vi.advanceTimersByTimeAsync(0);
    expect(dave.changes()).toEqual([
      { connectionId: 'kofi', memberId: 'kofi', state: { viewingMessageId: 'm2' } },
    ]);
  });

  it('clears the states of a connection whose wake fails', async () => {
    const { engine, storage } = buildEngine({ hibernation: true });
    await engine.initialize();
    writeConnectionRow(storage.sql, sleepingRow('ama', {}));
    const ama = sleepingSocket('ama');
    const kofi = sleepingSocket('kofi', { failSend: true });

    await engine.restoreHibernatedConnections([ama]);
    // Written after the boot restore, which deletes the rows of sockets it was not given.
    writeConnectionRow(storage.sql, sleepingRow('kofi', { [generalKey]: kofiViewing }, ['s1']));

    expect(() => engine.handleHibernationWake(kofi)).toThrow('socket gone');
    await quiet();

    expect(ama.changes()).toEqual([{ connectionId: 'kofi', state: null }]);
    expect(readConnectionRow(storage.sql, 'kofi')).toBeNull();
  });

  it('clears a saved state the schema no longer accepts, for peers woken after it too', async () => {
    const { engine, storage } = buildEngine({ hibernation: true });
    await engine.initialize();
    // A redeploy changed the schema: a number is no longer a valid message ID.
    const stale = { ...kofiViewing, state: '{"viewingMessageId":5}' };
    writeConnectionRow(storage.sql, sleepingRow('kofi', { [generalKey]: stale }));
    writeConnectionRow(
      storage.sql,
      sleepingRow('ama', { [generalKey]: { ...kofiViewing, meta: '{bad' } }),
    );
    const kofi = sleepingSocket('kofi');
    const ama = sleepingSocket('ama');

    await engine.restoreHibernatedConnections([kofi, ama]);
    await quiet();

    // Ama's own meta is broken JSON, so her entry goes too. One window carries both clears.
    const clears = [
      { connectionId: 'kofi', state: null },
      { connectionId: 'ama', state: null },
    ];
    expect(ama.changes()).toEqual(clears);
    expect(kofi.changes()).toEqual(clears);

    const dave = await connect(engine, 'dave');
    await dave.subscribe();
    expect(dave.of('__awarenessSync__')[0]![1]).toEqual({ entries: [] });
  });
});
