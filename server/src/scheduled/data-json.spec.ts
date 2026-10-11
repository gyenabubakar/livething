import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import { scheduled } from './capability.ts';

describe('scheduled task data', () => {
  it('reaches the task as the JSON that is stored, the same before and after a restart', async () => {
    const base = server({
      capabilities: [scheduled({ remind: { data: t<{ at: string }>() } })],
    });
    const seen: unknown[] = [];
    base.scheduled('remind', {
      run(_ctx, data) {
        seen.push(data);
      },
    });
    const queue = base.on('queue', {
      run(ctx) {
        ctx.schedule('remind', { time: Date.now() - 1, data: { at: new Date(0) as never } });
      },
    });

    let captured: Engine | undefined;
    adapter({
      id: 'scheduled-data-json',
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
    })(base.assemble({ handlers: [queue] }), undefined as never);
    const engine = captured!;
    await engine.initialize();

    const handle = engine.accept(Symbol('alice'), {
      send() {},
      close() {},
      bufferedAmount: () => 0,
      userId: 'alice',
    } as never);
    await handle.handleMessage(JSON.stringify(['queue', {}, null]));
    await engine.handleAlarm();

    expect(seen).toEqual([{ at: '1970-01-01T00:00:00.000Z' }]);
  });
});
