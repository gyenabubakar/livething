import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { WriteGate } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';

const Text = t<{ text: string }>();

function buildDefinition(durability: 'strict' | 'best-effort') {
  const base = server({
    capabilities: [
      emits({ news: Text, dm: Text }),
      dedup(),
      sequence({ persist: true }),
      replay.history({ durability }),
    ],
  });

  const shout = base.on('shout', {
    input: v.object({ text: v.string() }),
    run(ctx, payload) {
      ctx.broadcast('news', { text: payload.text });
    },
  });

  // Sends one object twice, changing it between the sends.
  const shoutTwice = base.on('shout-twice', {
    run(ctx) {
      const news = { text: 'first' };
      ctx.broadcast('news', news);
      news.text = 'second';
      ctx.broadcast('news', news);
    },
  });

  const sendToUser = base.on('send-to-user', {
    input: v.object({ userId: v.string() }),
    run(ctx, payload) {
      ctx.users.get(payload.userId).broadcast('dm', { text: `for-${payload.userId}` });
    },
  });

  return base.assemble({ handlers: [shout, shoutTwice, sendToUser] });
}

/** A write gate the test opens by hand: `commit()` runs what the engine queued. */
function manualGate() {
  const commits: (() => boolean)[] = [];
  function commit() {
    return commits
      .splice(0)
      .map((run) => run())
      .every(Boolean);
  }

  const gate: WriteGate = {
    beforeNextWrite(queued) {
      commits.push(queued);
    },
    commitNow: commit,
  };

  return { gate, pending: () => commits.length, commit };
}

async function startEngine(writeGate?: WriteGate, durability: 'strict' | 'best-effort' = 'strict') {
  let captured: Engine | undefined;
  const errors: string[] = [];
  const runAdapter = adapter({
    id: 'replay-batched-commit-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error: (message) => errors.push(String(message)) },
        writeGate,
      });
      return {};
    },
  });
  runAdapter(buildDefinition(durability), undefined as never);
  if (!captured) throw new Error('engine not captured');

  await captured.initialize();

  return { engine: captured, errors };
}

async function connect(engine: Engine, userId: string) {
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol(userId), {
    send() {},
    close() {},
    bufferedAmount: () => 0,
    userId,
  });
  const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
  await connection.lifecycleReady;

  return (frame: unknown[]) => handle.handleMessage(JSON.stringify([...frame, null]));
}

function storedTexts(engine: Engine): string[] {
  return engine.core.storage.sql
    .exec<{ payload: string }>('SELECT payload FROM __livething_replay ORDER BY seq')
    .toArray()
    .map((row) => (JSON.parse(row.payload) as { text: string }).text);
}

describe('replay with a write gate', () => {
  it('keeps the rows of a turn in memory, and stores them in one transaction at the gate', async () => {
    const gate = manualGate();
    const { engine } = await startEngine(gate.gate);
    const send = await connect(engine, 'ann');

    await send(['shout', { text: 'one' }]);
    await send(['shout', { text: 'two' }]);

    expect(storedTexts(engine)).toEqual([]);
    expect(gate.pending()).toBe(1);

    const transaction = vi.spyOn(engine.core.storage.sql, 'transaction');
    expect(gate.commit()).toBe(true);

    expect(storedTexts(engine)).toEqual(['one', 'two']);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('stores each message as it was sent, even when the handler changes the object after', async () => {
    const gate = manualGate();
    const { engine } = await startEngine(gate.gate);
    const send = await connect(engine, 'ann');

    await send(['shout-twice', {}]);
    gate.commit();

    expect(storedTexts(engine)).toEqual(['first', 'second']);
  });

  it('drops the queued rows of a user who is purged before the gate commits', async () => {
    const gate = manualGate();
    const { engine } = await startEngine(gate.gate);
    const send = await connect(engine, 'ann');

    await send(['send-to-user', { userId: 'bob' }]);
    await send(['send-to-user', { userId: 'ann' }]);
    await purgeUser(engine.core, 'bob');
    gate.commit();

    expect(storedTexts(engine)).toEqual(['for-ann']);
  });

  it('stores what it can when the transaction fails, and reports the rows it could not store', async () => {
    const gate = manualGate();
    const { engine, errors } = await startEngine(gate.gate);
    const send = await connect(engine, 'ann');
    await send(['shout', { text: 'lost' }]);
    await send(['shout', { text: 'kept' }]);

    const { sql } = engine.core.storage;
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...params: unknown[]) => {
      if (/INTO __livething_replay\s/.test(query) && JSON.stringify(params).includes('lost')) {
        throw new Error('disk full');
      }

      return exec(query, ...params);
    }) as typeof sql.exec;

    expect(gate.commit()).toBe(false);
    expect(storedTexts(engine)).toEqual(['kept']);
    expect(errors.join('\n')).toMatch(/disk full/);
  });

  it('reports a best-effort row it could not store as no loss, so its message still goes out', async () => {
    const gate = manualGate();
    const { engine, errors } = await startEngine(gate.gate, 'best-effort');
    const send = await connect(engine, 'ann');
    await send(['shout', { text: 'lost' }]);
    await Promise.resolve();

    expect(gate.pending()).toBe(1);

    const { sql } = engine.core.storage;
    sql.exec = (() => {
      throw new Error('disk full');
    }) as typeof sql.exec;

    expect(gate.commit()).toBe(true);
    expect(errors.join('\n')).toMatch(/disk full/);
  });

  it('asks the gate again for the rows of the next turn', async () => {
    const gate = manualGate();
    const { engine } = await startEngine(gate.gate);
    const send = await connect(engine, 'ann');

    await send(['shout', { text: 'one' }]);
    gate.commit();
    await send(['shout', { text: 'two' }]);

    expect(gate.pending()).toBe(1);
    gate.commit();
    expect(storedTexts(engine)).toEqual(['one', 'two']);
  });
});

describe('replay without a write gate', () => {
  it('stores the row before the broadcast returns', async () => {
    const { engine } = await startEngine();
    const send = await connect(engine, 'ann');

    await send(['shout', { text: 'one' }]);

    expect(storedTexts(engine)).toEqual(['one']);
  });
});
