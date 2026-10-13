import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { StorageProvider } from '~/context.ts';
import { scheduled } from './capability.ts';

describe('scheduled task data', () => {
  it('reaches the task as the JSON that is stored, the same before and after a restart', async () => {
    const base = server({
      capabilities: [scheduled({ remind: { data: t<{ at: Date }>() } })],
    });
    const seen: unknown[] = [];
    base.scheduled('remind', {
      run(_ctx, data) {
        seen.push(data);
      },
    });
    const queue = base.on('queue', {
      run(ctx) {
        ctx.schedule('remind', { time: Date.now() - 1, data: { at: new Date(0) } });
      },
    });
    const definition = base.assemble({ handlers: [queue] });

    async function startEngine(storage: StorageProvider): Promise<Engine> {
      let captured: Engine | undefined;
      adapter({
        id: 'scheduled-data-json',
        asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
        setup(createEngine) {
          captured = createEngine({
            storage,
            platform: {},
            timers: createTestTimers(),
            logger: { info() {}, warn() {}, error() {} },
          });
          return {};
        },
      })(definition, undefined as never);
      await captured!.initialize();

      return captured!;
    }

    async function queueTask(engine: Engine): Promise<void> {
      const handle = engine.accept(Symbol('alice'), {
        send() {},
        close() {},
        bufferedAmount: () => 0,
        userId: 'alice',
      } as never);
      await handle.handleMessage(JSON.stringify(['queue', {}, null]));
    }

    // Runs on the engine that queued it.
    const first = await startEngine(createTestStorage());
    await queueTask(first);
    await first.handleAlarm();

    // Queued, then run by a new engine on the same storage, as after a restart.
    const storage = createTestStorage();
    await queueTask(await startEngine(storage));
    await (await startEngine(storage)).handleAlarm();

    expect(seen).toEqual([{ at: '1970-01-01T00:00:00.000Z' }, { at: '1970-01-01T00:00:00.000Z' }]);
  });
});
