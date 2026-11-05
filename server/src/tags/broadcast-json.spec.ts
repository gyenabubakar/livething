import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { emits } from '~/emits/emits.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

describe('a tag group broadcast', () => {
  it('calls toJSON once, so every member gets the same payload', async () => {
    let calls = 0;
    const record = {
      toJSON() {
        calls += 1;
        return { version: calls };
      },
    };

    const base = server({
      capabilities: [
        emits({ news: t<{ version: number }>() }),
        tags((ephemeral) => [ephemeral('team', t<string>())]),
      ],
    });
    let captured: Engine | undefined;
    adapter({
      id: 'tag-broadcast-json-spec',
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
    })(
      base.assemble({
        handlers: [
          base.on('join', {
            run(ctx) {
              ctx.tags.ephemeral('team').add('a');
            },
          }),
          base.on('announce', {
            run(ctx) {
              ctx.tags.ephemeral('team').broadcast('news', record as never);
            },
          }),
        ],
      }) as never,
      undefined as never,
    );
    const engine = captured!;
    await engine.initialize();

    const received: unknown[] = [];
    async function open(userId: string) {
      const before = new Set(engine.core.connections.keys());
      const handle = engine.accept(Symbol(userId), {
        send({ text: data }: { kind: 'text'; text: string }) {
          const frame = JSON.parse(data) as [string, unknown];
          if (frame[0] === 'news') received.push(frame[1]);
        },
        close() {},
        bufferedAmount: () => 0,
        userId,
      });
      const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
      await connection.lifecycleReady;

      return handle;
    }

    const alice = await open('alice');
    const bob = await open('bob');
    await alice.handleMessage(JSON.stringify(['join', {}, null]));
    await bob.handleMessage(JSON.stringify(['join', {}, null]));
    await alice.handleMessage(JSON.stringify(['announce', {}, null]));

    expect(calls).toBe(1);
    expect(received).toEqual([{ version: 1 }, { version: 1 }]);
  });
});
