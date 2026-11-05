import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { emits } from '~/emits/emits.ts';
import { expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

it('does not re-run onOutgoing for a send made inside onOutgoing', async () => {
  let hookCalls = 0;
  const logError = vi.fn();
  const base = server({
    capabilities: [emits({ note: t<{}>(), audit: t<{}>() })],
    onOutgoing(ctx) {
      hookCalls += 1;
      ctx?.send('audit', {});
    },
  });
  const definition = base.assemble({
    handlers: [
      base.on('direct', {
        run(ctx) {
          ctx.send('note', {});
        },
      }),
    ],
  });

  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'outgoing-hook-send-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error: logError },
      });
      return {};
    },
  });
  runAdapter(definition, undefined as never);
  const engine = captured!;
  await engine.initialize();

  const frames: string[] = [];
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol('alice'), {
    send: ({ text: data }: { kind: 'text'; text: string }) => {
      frames.push(data);
    },
    close() {},
    bufferedAmount: () => 0,
    userId: 'alice',
  });
  await [...engine.core.connections.values()].find((c) => !before.has(c.id))!.lifecycleReady;

  await handle.handleMessage(JSON.stringify(['direct', {}, null]));

  expect(hookCalls).toBe(1);
  expect(logError).not.toHaveBeenCalled();
  expect(frames.map((frame) => (JSON.parse(frame) as unknown[])[0])).toEqual(['note', 'audit']);
});
