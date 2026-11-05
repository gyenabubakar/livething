import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import * as v from 'valibot';
import { expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

interface FrameMeta {
  stream?: { id?: string; terminated?: boolean };
}

type Frame = [string, Record<string, unknown> | null, FrameMeta | null];

async function buildEngine(): Promise<Engine> {
  const base = server({ capabilities: [recordedStream()] });
  const definition = base.assemble({
    handlers: [
      base.recordedStream('ticks', {
        input: v.object({}),
        chunk: t<{ n: number }>(),
        maxChunks: 1000,
        maxAgeMs: 60_000,
        retentionAfterEndMs: 60_000,
        async *run(ctx) {
          for (let n = 1; n <= 150 && !ctx.stream.signal.aborted; n += 1) {
            yield { n };
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
        },
      }),
    ],
  });

  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'stream-takeover-spec',
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

async function connect(engine: Engine, userId: string) {
  const frames: Frame[] = [];
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol(userId), {
    send({ text: data }: { kind: 'text'; text: string }) {
      frames.push(JSON.parse(data) as Frame);
    },
    close() {},
    bufferedAmount: () => 0,
    userId,
  });
  await [...engine.core.connections.values()].find((c) => !before.has(c.id))!.lifecycleReady;

  return { frames, send: (frame: Frame) => handle.handleMessage(JSON.stringify(frame)) };
}

it('ends the stream for the first tab with an abort frame when a second tab takes it over', async () => {
  const engine = await buildEngine();
  const firstTab = await connect(engine, 'alice');
  const secondTab = await connect(engine, 'alice');

  void firstTab.send(['ticks', {}, { stream: { id: 's-1' } }]);
  await expect
    .poll(() => firstTab.frames.filter(([event]) => event === 'ticks').length)
    .toBeGreaterThanOrEqual(2);

  await secondTab.send(['__continueStream__', { lastKnownSeq: 0 }, { stream: { id: 's-1' } }]);

  expect(secondTab.frames.map(([event]) => event)).toContain('__streamOk__');
  const abort = firstTab.frames.find(
    ([event, payload, meta]) =>
      event === '__error__' && payload?.code === 'stream-aborted' && meta?.stream?.id === 's-1',
  );
  expect(abort?.[1]?.detail).toEqual({ reason: 'taken-over' });
  expect(abort?.[2]?.stream?.terminated).toBe(true);
});
