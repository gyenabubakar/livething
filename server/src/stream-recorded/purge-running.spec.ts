import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import * as v from 'valibot';
import { expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

const tick = { generated: 0, stopped: false };

async function buildEngine(): Promise<Engine> {
  const base = server({ capabilities: [recordedStream()] });
  const definition = base.assemble({
    handlers: [
      base.recordedStream('ticks', {
        input: v.object({}),
        maxChunks: 1000,
        maxAgeMs: 60_000,
        retentionAfterEndMs: 60_000,
        async *run(ctx) {
          try {
            for (let n = 1; n <= 200 && !ctx.stream.signal.aborted; n += 1) {
              tick.generated = n;
              yield { n };
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
          } finally {
            tick.stopped = true;
          }
        },
      }),
    ],
  });

  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'stream-purge-spec',
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

it.each([
  ['arrives at once', 0],
  ['arrives late', 50],
])(
  'stops a running recorded stream and keeps none of its rows when a purged user socket close %s',
  async (_label, closeDelayMs) => {
    tick.generated = 0;
    tick.stopped = false;
    const engine = await buildEngine();
    const sql = engine.core.storage.sql;
    function rowCount(table: string): number {
      return Number(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one()?.n);
    }

    const before = new Set(engine.core.connections.keys());
    const socket = { close: (): void => {} };
    const handle = engine.accept(Symbol('alice'), {
      send() {
        return true;
      },
      close: () => socket.close(),
      bufferedAmount: () => 0,
      userId: 'alice',
    });
    socket.close = () => {
      if (closeDelayMs === 0) void handle.handleClose(1000, 'user purged');
      else setTimeout(() => void handle.handleClose(1000, 'user purged'), closeDelayMs);
    };
    await [...engine.core.connections.values()].find((c) => !before.has(c.id))!.lifecycleReady;

    void handle.handleMessage(JSON.stringify(['ticks', {}, { stream: { id: 's-1' } }]));
    await expect.poll(() => rowCount('__livething_stream_chunks')).toBeGreaterThanOrEqual(3);

    await purgeUser(engine.core, 'alice');
    await new Promise((resolve) => setTimeout(resolve, closeDelayMs + 60));

    expect(tick.stopped).toBe(true);
    expect(rowCount('__livething_stream_chunks')).toBe(0);
    expect(rowCount('__livething_streams')).toBe(0);
  },
);
