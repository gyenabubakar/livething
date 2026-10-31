import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { scheduleTask } from '~/_engine/scheduling.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

async function buildEngine(): Promise<Engine> {
  const base = server({
    capabilities: [scheduled({ chargeCard: { retry: false }, sendReceipt: null })],
  });
  const definition = base.assemble({
    handlers: [
      base.scheduled('chargeCard', {
        run() {
          throw new Error('card declined');
        },
      }),
      base.scheduled('sendReceipt', { run() {} }),
    ],
  });

  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'dead-letter-retry-spec',
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

it('writes a dead letter on a later persist and alarm after its first insert fails', async () => {
  const engine = await buildEngine();
  const { sql } = engine.core.storage;
  function queue(taskId: string) {
    scheduleTask(engine.core, () => ({}), { taskId, time: 1, data: undefined });
  }

  const exec = sql.exec.bind(sql);
  let failNextInsert = true;
  sql.exec = ((query: string, ...params: unknown[]) => {
    if (failNextInsert && query.includes('INTO __livething_scheduled_dlq')) {
      failNextInsert = false;
      throw new Error('disk full');
    }

    return exec(query, ...params);
  }) as typeof sql.exec;

  queue('chargeCard');
  await engine.handleAlarm().catch(() => {});
  expect(failNextInsert).toBe(false);

  queue('sendReceipt');
  await engine.handleAlarm();

  const taskIds = sql
    .exec<{ taskId: string }>('SELECT taskId FROM __livething_scheduled_dlq')
    .toArray()
    .map((row) => row.taskId);
  expect(taskIds).toEqual(['chargeCard']);
});
