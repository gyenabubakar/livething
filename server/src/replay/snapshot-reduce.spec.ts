import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ReplayDurability, ReplaySnapshotValue } from '~/replay/types.ts';

function addTotals(
  previous: ReplaySnapshotValue | null,
  next: ReplaySnapshotValue,
): ReplaySnapshotValue {
  const before = previous ? Number(previous.payload?.total) : 0;
  return {
    event: next.event,
    payload: { ...next.payload, total: before + Number(next.payload?.total) },
  };
}

async function buildEngine(durability: ReplayDurability): Promise<Engine> {
  const base = server({
    capabilities: [
      emits({ counter: t<{ key: string; total: number }>() }),
      dedup(),
      sequence({ persist: true }),
      replay.snapshot({
        snapshotKey: (_event, payload) => String(payload?.key),
        reduce: addTotals,
        durability,
      }),
    ],
  });
  const increment = base.on('increment', {
    input: v.object({ amount: v.number() }),
    run(ctx, input) {
      ctx.broadcast('counter', { key: 'hits', total: input.amount }, { includeSelf: true });
    },
  });

  let engine: Engine | undefined;
  adapter({
    id: 'snapshot-reduce-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(base.assemble({ handlers: [increment] }), undefined as never);
  if (!engine) throw new Error('engine not captured');

  await engine.initialize();

  return engine;
}

async function connect(engine: Engine): Promise<(amount: number) => Promise<void>> {
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol('alice'), {
    send() {},
    close() {},
    bufferedAmount: () => 0,
    userId: 'alice',
  });
  const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
  await connection.lifecycleReady;

  return (amount) => handle.handleMessage(JSON.stringify(['increment', { amount }, null]));
}

function storedTotal(engine: Engine): number | undefined {
  const row = engine.core.storage.sql
    .exec<{ payload: string }>('SELECT payload FROM __livething_replay')
    .toArray()[0];
  return row ? Number((JSON.parse(row.payload) as { total: number }).total) : undefined;
}

describe.each<ReplayDurability>(['strict', 'best-effort'])('snapshot reduce (%s)', (durability) => {
  it('folds every increment into the stored total', async () => {
    const engine = await buildEngine(durability);
    const increment = await connect(engine);

    await increment(5);
    await increment(3);
    await increment(5);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(storedTotal(engine)).toBe(13);
  });

  it('folds increments that arrive back to back', async () => {
    const engine = await buildEngine(durability);
    const increment = await connect(engine);

    await Promise.all([increment(5), increment(3), increment(5)]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(storedTotal(engine)).toBe(13);
  });
});
