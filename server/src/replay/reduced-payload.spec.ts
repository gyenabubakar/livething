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
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

type Frame = [event: string, payload: Record<string, unknown>, livething: Record<string, unknown>];

describe('a snapshot reducer that returns a payload JSON turns into a string', () => {
  it('does not make every later replay request fail', async () => {
    const base = server({
      capabilities: [
        emits({ news: t<{ text: string }>() }),
        dedup(),
        sequence({ persist: true }),
        replay.snapshot({
          snapshotKey: () => 'only',
          reduce: (_previous, next) => ({
            event: next.event,
            payload: new Date(0) as unknown as Record<string, unknown>,
          }),
        }),
      ],
    });
    const shout = base.on('shout', {
      run(ctx) {
        ctx.broadcast('news', { text: 'top-news' });
      },
    });

    let captured: Engine | undefined;
    const runAdapter = adapter({
      id: 'reduced-payload-spec',
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
    runAdapter(base.assemble({ handlers: [shout] }), undefined as never);
    const engine = captured!;
    await engine.initialize();

    async function connect(userId: string) {
      const frames: Frame[] = [];
      const before = new Set(engine.core.connections.keys());
      const handle = engine.accept(Symbol(userId), {
        send(data: string) {
          frames.push(JSON.parse(data) as Frame);
        },
        close() {},
        bufferedAmount: () => 0,
        userId,
      });
      const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
      await connection.lifecycleReady;

      return { frames, send: (frame: unknown[]) => handle.handleMessage(JSON.stringify(frame)) };
    }

    const alice = await connect('alice');
    await alice.send(['shout', {}, null]);

    const bob = await connect('bob');
    await bob.send(['__replay__', { lastKnownSeq: 0 }, null]);

    expect(bob.frames.map(([event]) => event)).not.toContain('__error__');
  });
});
