import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox } from '~/inbox/capability.ts';
import { lastSeen } from '~/last-seen/capability.ts';
import { readLastSeen } from '~/last-seen/storage.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

interface Gate {
  entered: Promise<void>;
  enter(): void;
  released: Promise<void>;
  release(): void;
}

function createGate(): Gate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { entered, enter, released, release };
}

async function buildEngine(gate: Gate, replayCapability = replay.history()): Promise<Engine> {
  const base = server({
    capabilities: [
      emits({ note: t<{ text: string }>() }),
      dedup(),
      sequence({ persist: true }),
      replayCapability,
      channels(),
      lastSeen(),
      tags((_ephemeral, persistent) => [persistent('team', t<string>())]),
    ],
  });
  const room = base.channel('room', {
    membership: 'persistent',
    capabilities: [emits({ note: t<{ text: string }>() }), inbox()],
  });
  const definition = base.assemble({
    handlers: [
      room,
      base.on('write-everything', {
        async run(ctx) {
          gate.enter();
          await gate.released;
          ctx.user.broadcast('note', { text: 'late' });
          ctx.tags.persistent('team').add('red');
          await ctx.channels.get('room').subscribe(ctx.connection);

          ctx.channels
            .get('room')
            .inbox()
            ?.backfill('alice', [
              { event: 'note', payload: { text: 'late' }, __livething: { messageId: 'late-1' } },
            ]);
        },
      }),
      base.on('write-to-alice', {
        async run(ctx) {
          gate.enter();
          await gate.released;
          ctx.users.get('alice').broadcast('note', { text: 'late' });
        },
      }),
      base.on('queue-then-wait', {
        async run(ctx) {
          ctx.user.broadcast('note', { text: 'queued' });
          gate.enter();
          await gate.released;
        },
      }),
      base.on('write-now', {
        run(ctx) {
          ctx.user.broadcast('note', { text: 'after' });
        },
      }),
    ],
  });

  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'purge-in-flight-spec',
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

  await captured.initialize();

  return captured;
}

async function connect(engine: Engine, userId: string) {
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol(userId), {
    send() {},
    close() {},
    bufferedAmount: () => 0,
    userId,
  });
  await [...engine.core.connections.values()].find((c) => !before.has(c.id))!.lifecycleReady;

  return handle;
}

function count(engine: Engine, query: string, ...params: unknown[]): number {
  const row = engine.core.storage.sql.exec<{ n: number }>(query, ...params).one();
  return Number(row?.n);
}

function rowsFor(engine: Engine, userId: string) {
  return {
    replay: count(engine, 'SELECT COUNT(*) AS n FROM __livething_replay WHERE userId = ?', userId),
    tags: count(engine, 'SELECT COUNT(*) AS n FROM __livething_tags WHERE user_id = ?', userId),
    memberships: count(
      engine,
      'SELECT COUNT(*) AS n FROM __livething_channel_memberships WHERE user_id = ?',
      userId,
    ),
    inbox: count(engine, 'SELECT COUNT(*) AS n FROM __livething_inbox WHERE user_id = ?', userId),
  };
}

describe('purgeUser and work already running', () => {
  it('leaves no lastSeen row after the purged socket really closes', async () => {
    const engine = await buildEngine(createGate());
    const alice = await connect(engine, 'alice');

    await engine.admin().purgeUser('alice');
    await alice.handleClose(1000, 'user purged');

    expect(readLastSeen(engine.core.storage.sql, 'alice')).toBeNull();
  });

  it('stops a handler that started before the purge from writing rows after it', async () => {
    const gate = createGate();
    const engine = await buildEngine(gate);
    const alice = await connect(engine, 'alice');

    const running = alice.handleMessage(JSON.stringify(['write-everything', {}, null]));
    await gate.entered;
    await engine.admin().purgeUser('alice');
    gate.release();
    await running.catch(() => {});

    expect(rowsFor(engine, 'alice')).toEqual({ replay: 0, tags: 0, memberships: 0, inbox: 0 });
  });

  it("stops another user's handler that started before the purge too", async () => {
    const gate = createGate();
    const engine = await buildEngine(gate);
    const bob = await connect(engine, 'bob');

    const running = bob.handleMessage(JSON.stringify(['write-to-alice', {}, null]));
    await gate.entered;
    await engine.admin().purgeUser('alice');
    gate.release();
    await running;

    expect(rowsFor(engine, 'alice').replay).toBe(0);
  });

  it('lets the same user id write again from a connection opened after the purge', async () => {
    const engine = await buildEngine(createGate());
    await connect(engine, 'alice');
    await engine.admin().purgeUser('alice');

    const again = await connect(engine, 'alice');
    await again.handleMessage(JSON.stringify(['write-now', {}, null]));

    expect(rowsFor(engine, 'alice').replay).toBe(1);
  });

  it('drops a snapshot row a handler queued before the purge', async () => {
    const gate = createGate();
    const engine = await buildEngine(gate, replay.snapshot());
    const alice = await connect(engine, 'alice');

    const running = alice.handleMessage(JSON.stringify(['queue-then-wait', {}, null]));
    await gate.entered;
    await engine.admin().purgeUser('alice');
    gate.release();
    await running;

    expect(rowsFor(engine, 'alice').replay).toBe(0);
  });
});
