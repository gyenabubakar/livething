import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { WriteGate } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';

const Text = t<{ text: string }>();

function buildDefinition(durability: 'strict' | 'best-effort', maxBytes?: number) {
  const base = server({
    capabilities: [
      emits({ news: Text, dm: Text }),
      channels(),
      dedup(),
      sequence({ persist: true }),
      replay.history({ durability, ...(maxBytes ? { retention: { maxBytes } } : {}) }),
    ],
  });

  const noteToSelf = base.on('note-to-self', {
    input: v.object({ text: v.string() }),
    run(ctx, payload) {
      ctx.send('dm', { text: payload.text });
    },
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

  const room = base.channel('room', { capabilities: [emits({ said: Text })] });
  const say = room.on('say', {
    input: v.object({ text: v.string() }),
    run(ctx, payload) {
      ctx.channel.broadcast('said', { text: payload.text });
    },
  });

  return base.assemble({ handlers: [shout, shoutTwice, sendToUser, noteToSelf, room, say] });
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

async function startEngine(
  writeGate?: WriteGate,
  durability: 'strict' | 'best-effort' = 'strict',
  maxBytes?: number,
) {
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
  runAdapter(buildDefinition(durability, maxBytes), undefined as never);
  if (!captured) throw new Error('engine not captured');

  await captured.initialize();

  return { engine: captured, errors };
}

async function connect(engine: Engine, userId: string, sent: unknown[][] = []) {
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol(userId), {
    send: ({ text }: { kind: 'text'; text: string }) => sent.push(JSON.parse(text) as unknown[]),
    close() {},
    bufferedAmount: () => 0,
    userId,
  });
  const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
  await connection.lifecycleReady;

  return (frame: unknown[]) =>
    handle.handleMessage(JSON.stringify(frame.length === 3 ? frame : [...frame, null]));
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

  it('does not count the rows a failed transaction rolled back, so it prunes no row within retention', async () => {
    const probe = manualGate();
    const sized = await startEngine(probe.gate);
    await (
      await connect(sized.engine, '')
    )(['note-to-self', { text: 'note-0' }]);
    probe.commit();
    const { rowBytes } = sized.engine.core.storage.sql
      .exec<{ rowBytes: number }>('SELECT rowBytes FROM __livething_replay')
      .one()!;

    const gate = manualGate();
    const { engine } = await startEngine(gate.gate, 'strict', rowBytes * 10);
    const send = await connect(engine, '');
    for (let index = 1; index <= 9; index++) {
      await send(['note-to-self', { text: `note-${index}` }]);
    }

    gate.commit();

    await send(['note-to-self', { text: 'note-x' }]);
    await send(['note-to-self', { text: 'lost' }]);
    const { sql } = engine.core.storage;
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...params: unknown[]) => {
      if (/INTO __livething_replay\s/.test(query) && JSON.stringify(params).includes('lost')) {
        throw new Error('disk full');
      }

      return exec(query, ...params);
    }) as typeof sql.exec;

    expect(gate.commit()).toBe(false);
    expect(storedTexts(engine)).toHaveLength(10);
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

describe('a channel catch-up in the turn of a broadcast', () => {
  it('gets the message it missed, though the gate has not stored its row yet', async () => {
    const gate = manualGate();
    const { engine } = await startEngine(gate.gate);
    const inRoom = { channel: { name: 'room' } };
    const sendAnn = await connect(engine, 'ann');
    const kofiFrames: unknown[][] = [];

    const sendKofi = await connect(engine, 'kofi', kofiFrames);
    await sendAnn(['__subscribe__', {}, inRoom]);
    gate.commit();

    await sendAnn(['say', { text: 'before kofi joins' }, inRoom]);
    await sendKofi(['__subscribe__', {}, inRoom]);
    await sendKofi(['__replay__', { lastKnownSeq: 0 }, inRoom]);
    await new Promise((resolve) => setImmediate(resolve));

    const said = kofiFrames.filter((frame) => frame[0] === 'said').map((frame) => frame[1]);
    expect(said).toEqual([{ text: 'before kofi joins' }]);
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
