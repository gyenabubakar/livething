import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import * as v from 'valibot';
import { expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

type Frame = [string, Record<string, unknown> | null, { stream?: { id?: string } } | null];

const retention = { maxChunks: 1000, maxAgeMs: 60_000, retentionAfterEndMs: 60_000 };
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setup() {
  const seen = { stuckSignal: false, tickingSignal: false };
  const base = server({ capabilities: [recordedStream()] });

  async function* ticking(ctx: { stream: { signal: AbortSignal } }) {
    for (let n = 1; n <= 2000; n += 1) {
      if (ctx.stream.signal.aborted) seen.tickingSignal = true;
      yield { n };
      await pause(2);
    }
  }

  const definition = base.assemble({
    handlers: [
      base.recordedStream('feed', {
        input: v.object({}),
        chunk: t<{ n: number }>(),
        broadcast: true,
        ...retention,
        run: ticking,
      }),
      base.recordedStream('solo', {
        input: v.object({}),
        chunk: t<{ n: number }>(),
        ...retention,
        run: ticking,
      }),
      base.recordedStream('stuck', {
        input: v.object({}),
        chunk: t<{ n: number }>(),
        ...retention,
        async *run(ctx) {
          ctx.stream.signal.addEventListener('abort', () => {
            seen.stuckSignal = true;
          });
          yield { n: 1 };
          await new Promise(() => {});
        },
      }),
    ],
  });

  let captured: Engine | undefined;
  adapter({
    id: 'purge-stops-streams-spec',
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
  })(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  const engine = captured;
  await engine.initialize();

  const sql = engine.core.storage.sql;
  function chunks(streamId: string): number {
    return Number(
      sql
        .exec<{
          n: number;
        }>('SELECT COUNT(*) AS n FROM __livething_stream_chunks WHERE stream_id = ?', streamId)
        .one()?.n,
    );
  }

  function streamRow(streamId: string) {
    return sql
      .exec<{
        status: string;
        creator_user_id: string | null;
      }>('SELECT status, creator_user_id FROM __livething_streams WHERE stream_id = ?', streamId)
      .toArray()[0];
  }

  async function connect(userId: string) {
    const frames: Frame[] = [];
    const before = new Set(engine.core.connections.keys());
    const socket = { close: (): void => {} };
    const handle = engine.accept(Symbol(userId), {
      send({ text: data }: { kind: 'text'; text: string }) {
        frames.push(JSON.parse(data) as Frame);
        return true;
      },
      close: () => socket.close(),
      bufferedAmount: () => 0,
      userId,
    });
    socket.close = () => void handle.handleClose(1000, 'user purged');

    await [...engine.core.connections.values()].find((c) => !before.has(c.id))!.lifecycleReady;

    return {
      frames,
      start(event: string, id: string) {
        void handle.handleMessage(JSON.stringify([event, {}, { stream: { id } }]));
      },
    };
  }

  return { engine, seen, chunks, streamRow, connect };
}

it('fires the stream signal when its user is purged', async () => {
  const { engine, seen, chunks, connect } = await setup();
  const alice = await connect('alice');
  alice.start('solo', 's-1');
  await expect.poll(() => chunks('s-1')).toBeGreaterThanOrEqual(2);

  await purgeUser(engine.core, 'alice');
  await pause(30);

  expect(seen.tickingSignal).toBe(true);
});

it('fires the signal and finishes the purge when the generator is stuck in an await', async () => {
  const { engine, seen, chunks, connect } = await setup();
  const alice = await connect('alice');
  alice.start('stuck', 's-1');
  await expect.poll(() => chunks('s-1')).toBe(1);

  const outcome = await Promise.race([
    purgeUser(engine.core, 'alice').then(() => 'finished'),
    pause(500).then(() => 'purge hung'),
  ]);

  expect(outcome).toBe('finished');
  expect(seen.stuckSignal).toBe(true);
  expect(engine.core.activeStreams.size).toBe(0);
});

it('keeps recorded chunks but records no more with keepBroadcastContent', async () => {
  const { engine, chunks, streamRow, connect } = await setup();
  const alice = await connect('alice');
  alice.start('feed', 's-1');
  await expect.poll(() => chunks('s-1')).toBeGreaterThanOrEqual(3);

  await purgeUser(engine.core, 'alice', { keepBroadcastContent: true });
  const atPurge = chunks('s-1');
  await pause(40);

  expect(atPurge).toBeGreaterThanOrEqual(3);
  expect(chunks('s-1')).toBe(atPurge);
  expect(streamRow('s-1')).toMatchObject({ status: 'ended', creator_user_id: null });
  expect(engine.core.activeStreams.size).toBe(0);
});

it.each([[false], [true]])(
  'tells broadcast subscribers the stream ended when its creator is purged (keepBroadcastContent %s)',
  async (keepBroadcastContent) => {
    const { engine, chunks, connect } = await setup();
    const bob = await connect('bob');
    const alice = await connect('alice');
    alice.start('feed', 's-1');
    await expect.poll(() => chunks('s-1')).toBeGreaterThanOrEqual(2);

    await purgeUser(engine.core, 'alice', { keepBroadcastContent });
    await pause(20);

    const ends = bob.frames.filter(
      ([event, , meta]) => event === '__streamEnd__' && meta?.stream?.id === 's-1',
    );
    expect(ends).toHaveLength(1);
  },
);

it('leaves another user running stream alone', async () => {
  const { engine, chunks, connect } = await setup();
  const alice = await connect('alice');
  const bob = await connect('bob');
  alice.start('solo', 'alice-1');
  bob.start('solo', 'bob-1');

  await expect.poll(() => chunks('bob-1')).toBeGreaterThanOrEqual(2);

  await purgeUser(engine.core, 'alice');
  const atPurge = chunks('bob-1');
  await pause(30);

  expect(chunks('alice-1')).toBe(0);
  expect(chunks('bob-1')).toBeGreaterThan(atPurge);
  expect(engine.core.activeStreams.has('bob-1')).toBe(true);
});
