import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { readStream } from '~/_engine/stream-durable/storage.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

interface FrameMeta {
  channel?: { name?: string; unsubscribeId?: string };
  stream?: { id?: string; terminated?: boolean };
}

type Frame = [string, Record<string, unknown> | null, FrameMeta | null];

interface Run {
  reason: unknown;
  finished: boolean;
}

const Empty = v.object({});

function buildDefinition(runs: Map<string, Run>) {
  const base = server({
    capabilities: [
      channels(),
      stream(),
      recordedStream(),
      tags((ephemeral) => [ephemeral('role', t<string>())]),
    ],
  });

  function ticks(name: string) {
    return async function* run(ctx: { stream: { signal: AbortSignal } }) {
      const record: Run = { reason: undefined, finished: false };
      runs.set(name, record);
      try {
        for (let n = 1; n <= 10_000; n += 1) {
          yield { n };
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      } finally {
        record.finished = true;
        record.reason = ctx.stream.signal.reason;
      }
    };
  }

  const room = base.channel('room', { membership: 'persistent' });
  const other = base.channel('other', {});

  const handlers = [
    room.stream('plain-ticks', { input: Empty, run: ticks('plain-ticks') }),
    room.stream('broadcast-ticks', {
      input: Empty,
      broadcast: true,
      run: ticks('broadcast-ticks'),
    }),
    room.recordedStream('recorded-ticks', {
      input: Empty,
      maxChunks: 100_000,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 60_000,
      run: ticks('recorded-ticks'),
    }),
    other.stream('other-ticks', { input: Empty, run: ticks('other-ticks') }),
    room.on('kick-me', {
      async run(ctx) {
        await ctx.channel.kick(ctx.users.get('alice').ref(), { reason: 'bye' });
      },
    }),
  ];

  return base.assemble({ handlers });
}

async function buildEngine(runs: Map<string, Run>): Promise<Engine> {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'stream-channel-leave-spec',
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
  runAdapter(buildDefinition(runs), undefined as never);
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
  const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
  await connection.lifecycleReady;

  return {
    connection,
    frames,
    send: (frame: Frame) => handle.handleMessage(JSON.stringify(frame)),
    close: () => handle.handleClose(1006, 'dropped'),
  };
}

type Client = Awaited<ReturnType<typeof connect>>;

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;

    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  throw new Error('condition never became true');
}

function chunksOf(client: Client, streamId: string): number {
  return client.frames.filter(
    ([event, , meta]) => !event.startsWith('__') && meta?.stream?.id === streamId,
  ).length;
}

async function startStream(client: Client, event: string, streamId: string) {
  const channel = event === 'other-ticks' ? 'other' : 'room';
  void client.send([event, {}, { channel: { name: channel }, stream: { id: streamId } }]);
  await until(() => chunksOf(client, streamId) >= 2);
}

function abortedFrame(client: Client, streamId: string): Frame | undefined {
  return client.frames.find(
    ([event, payload, meta]) =>
      event === '__error__' && meta?.stream?.id === streamId && payload?.code === 'stream-aborted',
  );
}

async function subscribe(client: Client, channel = 'room'): Promise<void> {
  await client.send(['__subscribe__', {}, { channel: { name: channel } }]);
}

async function unsubscribe(client: Client, channel = 'room'): Promise<void> {
  await client.send(['__unsubscribe__', null, { channel: { name: channel, unsubscribeId: 'u1' } }]);
}

async function expectNoMoreChunks(client: Client, streamId: string): Promise<void> {
  const count = chunksOf(client, streamId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(chunksOf(client, streamId)).toBe(count);
}

describe('leaving a channel stops the streams scoped to it', () => {
  it('stops a plain channel stream on unsubscribe and tells the client', async () => {
    const runs = new Map<string, Run>();
    const engine = await buildEngine(runs);
    const alice = await connect(engine, 'alice');
    await subscribe(alice);
    await startStream(alice, 'plain-ticks', 's-plain');

    await unsubscribe(alice);

    expect(runs.get('plain-ticks')).toEqual({ reason: 'unsubscribed', finished: true });
    const [, payload, meta] = abortedFrame(alice, 's-plain')!;
    expect(payload).toEqual({ code: 'stream-aborted', detail: { reason: 'unsubscribed' } });
    expect(meta?.stream?.terminated).toBe(true);
    expect(meta?.channel?.name).toBe('room');

    expect(engine.core.activeStreams.has('s-plain')).toBe(false);
    await expectNoMoreChunks(alice, 's-plain');
  });

  it('sends the stream-aborted frame before the unsubscribe confirmation', async () => {
    const runs = new Map<string, Run>();
    const engine = await buildEngine(runs);
    const alice = await connect(engine, 'alice');
    await subscribe(alice);
    await startStream(alice, 'plain-ticks', 's-order');

    await unsubscribe(alice);

    const events = alice.frames.map(([event, payload]) =>
      event === '__error__' ? `__error__:${String(payload?.code)}` : event,
    );
    const abortedAt = events.indexOf('__error__:stream-aborted');
    expect(abortedAt).toBeGreaterThanOrEqual(0);
    expect(abortedAt).toBeLessThan(events.indexOf('__unsubscribeOk__'));
  });

  it('stops a channel stream when the member is kicked', async () => {
    const runs = new Map<string, Run>();
    const engine = await buildEngine(runs);
    const alice = await connect(engine, 'alice');
    await subscribe(alice);
    await startStream(alice, 'plain-ticks', 's-kick');

    await alice.send(['kick-me', {}, { channel: { name: 'room' } }]);

    expect(runs.get('plain-ticks')).toEqual({ reason: 'unsubscribed', finished: true });
    expect(abortedFrame(alice, 's-kick')).toBeDefined();
    await expectNoMoreChunks(alice, 's-kick');
  });

  it('leaves a stream scoped to another channel running', async () => {
    const runs = new Map<string, Run>();
    const engine = await buildEngine(runs);
    const alice = await connect(engine, 'alice');
    await subscribe(alice);
    await subscribe(alice, 'other');

    await startStream(alice, 'other-ticks', 's-other');

    await unsubscribe(alice);

    expect(runs.get('other-ticks')?.finished).toBe(false);
    expect(abortedFrame(alice, 's-other')).toBeUndefined();
    const count = chunksOf(alice, 's-other');
    await until(() => chunksOf(alice, 's-other') > count);

    await unsubscribe(alice, 'other');
    expect(runs.get('other-ticks')?.finished).toBe(true);
  });

  it('ends a broadcast stream for the peers when its creator leaves', async () => {
    const runs = new Map<string, Run>();
    const engine = await buildEngine(runs);
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await subscribe(alice);

    await subscribe(bob);
    await startStream(alice, 'broadcast-ticks', 's-bcast');
    await until(() => chunksOf(bob, 's-bcast') >= 1);

    await unsubscribe(alice);

    expect(runs.get('broadcast-ticks')).toEqual({ reason: 'unsubscribed', finished: true });
    expect(abortedFrame(alice, 's-bcast')).toBeDefined();
    expect(
      bob.frames.some(
        ([event, , meta]) => event === '__streamEnd__' && meta?.stream?.id === 's-bcast',
      ),
    ).toBe(true);
    await expectNoMoreChunks(bob, 's-bcast');
  });

  it('stops a recorded stream of a dropped tab once the user has no tab left in the channel', async () => {
    const runs = new Map<string, Run>();
    const engine = await buildEngine(runs);
    const firstTab = await connect(engine, 'alice');
    await subscribe(firstTab);
    await startStream(firstTab, 'recorded-ticks', 's-detached');

    await firstTab.close();
    expect(engine.core.activeStreams.get('s-detached')?.detached).toBe(true);

    const secondTab = await connect(engine, 'alice');
    await unsubscribe(secondTab);

    expect(runs.get('recorded-ticks')).toEqual({ reason: 'unsubscribed', finished: true });
    expect(engine.core.activeStreams.has('s-detached')).toBe(false);
    expect(readStream(engine.core.storage.sql, 'alice', 's-detached')).toBeNull();
  });

  it('keeps a recorded stream of a dropped tab while another tab of the user stays in the channel', async () => {
    const runs = new Map<string, Run>();
    const engine = await buildEngine(runs);
    const firstTab = await connect(engine, 'alice');
    await subscribe(firstTab);
    await startStream(firstTab, 'recorded-ticks', 's-kept');

    await firstTab.close();

    const secondTab = await connect(engine, 'alice');
    const thirdTab = await connect(engine, 'alice');
    await unsubscribe(secondTab);

    expect(runs.get('recorded-ticks')?.finished).toBe(false);
    expect(engine.core.activeStreams.get('s-kept')?.detached).toBe(true);

    await unsubscribe(thirdTab);
    expect(runs.get('recorded-ticks')?.finished).toBe(true);
  });

  it('stops a recorded channel stream and deletes it so it cannot be continued', async () => {
    const runs = new Map<string, Run>();
    const engine = await buildEngine(runs);
    const alice = await connect(engine, 'alice');
    await subscribe(alice);
    await startStream(alice, 'recorded-ticks', 's-recorded');

    await unsubscribe(alice);

    expect(runs.get('recorded-ticks')).toEqual({ reason: 'unsubscribed', finished: true });
    expect(abortedFrame(alice, 's-recorded')).toBeDefined();
    await expectNoMoreChunks(alice, 's-recorded');
    expect(readStream(engine.core.storage.sql, 'alice', 's-recorded')).toBeNull();

    await subscribe(alice);
    await alice.send([
      '__continueStream__',
      { lastKnownSeq: 0 },
      { channel: { name: 'room' }, stream: { id: 's-recorded' } },
    ]);
    const continueErrors = alice.frames.filter(
      ([event, , meta]) => event === '__error__' && meta?.stream?.id === 's-recorded',
    );
    const continueError = continueErrors[continueErrors.length - 1];
    expect(continueError?.[1]).toEqual({ code: 'stream-aborted', detail: { reason: 'not-found' } });
  });
});
