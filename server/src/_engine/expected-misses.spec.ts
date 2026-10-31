import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { emits } from '~/emits/emits.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ConnectionRef } from '~/context.ts';

async function buildApp() {
  const results: unknown[] = [];
  const refs = new Map<string, ConnectionRef>();
  const logError = vi.fn();
  const base = server({
    capabilities: [emits({ note: t<{ text: string }>() }), scheduled({ cleanup: null })],
    onConnect(ctx) {
      refs.set(ctx.connection.userId, ctx.connection);
    },
  });
  const definition = base.assemble({
    handlers: [
      base.scheduled('cleanup', { run() {} }),
      base.on('stop-cleanup', {
        run(ctx) {
          ctx.cancelScheduled('cleanup');
        },
      }),
      base.on('note-bob', {
        run(ctx) {
          results.push(ctx.connections.get(refs.get('bob')!).send('note', { text: 'hi' }));
        },
      }),
    ],
  });

  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'expected-misses-spec',
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
  if (!captured) throw new Error('engine not captured');

  await captured.initialize();

  return { engine: captured, results, logError };
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

describe('an expected miss is not an error', () => {
  it('does not log an error when cancelScheduled matches no run', async () => {
    const { engine, logError } = await buildApp();
    const alice = await connect(engine, 'alice');

    await alice.handleMessage(JSON.stringify(['stop-cleanup', {}, null]));

    expect(logError.mock.calls.map(([message]) => message)).toEqual([]);
  });

  it('returns false without logging an error when ctx.connections.get(ref).send finds no connection', async () => {
    const { engine, results, logError } = await buildApp();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await bob.handleClose(1000, 'bye');

    await alice.handleMessage(JSON.stringify(['note-bob', {}, null]));

    expect(results).toEqual([false]);
    expect(logError.mock.calls.map(([message]) => message)).toEqual([]);
  });
});
