/* oxlint-disable @typescript-eslint/no-explicit-any */
import { LiveThingConfigError, StreamAborted } from '@livething/core';
import * as ConnectionLifecycle from '~/_engine/runtime/connection.ts';
import { createTestSql } from '~/_test/sql.ts';
import { wrapStreamGenerator } from '~/stream/shared.ts';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveStream, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { SendThroughPipelineOptions, SharedSendOptions } from '~/outgoing/runtime.ts';
import { cancelDurableStream, continueDurableStream, runDurableStream } from './runtime.ts';
import * as Storage from './storage.ts';
import type { DurableStreamRuntimeDef } from './runtime.ts';

function createConnection(id = 'c1', userId = 'u1'): RuntimeConnection {
  return {
    id,
    userId,
    socketKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createRuntime(sqlInstance: ReturnType<typeof createTestSql>) {
  const protocolMessages: {
    targetId: string;
    event: string;
    payload: Record<string, unknown>;
    livething: Record<string, unknown>;
  }[] = [];
  const pipelineSends: { event: string; payload: unknown; routing: unknown; targetId: string }[] =
    [];
  let nextStreamId = 0;

  const broadcasts: {
    targets: readonly RuntimeConnection[];
    event: string;
    payload: unknown;
  }[] = [];
  const runtime = {
    sql: sqlInstance,
    messageLimits: { sendBytes: 32 * 1024 * 1024 },
    activeStreams: new Map<string, ActiveStream>(),
    connections: new Map<string, RuntimeConnection>(),
    generateId: () => `gen-${++nextStreamId}`,
    buildConnectionContext: () => ({ id: 'ctx', nudges: () => [] }),
    sendProtocolMessage: (
      conn: RuntimeConnection,
      { event, payload, livething }: SendProtocolMessageOptions,
    ) => {
      protocolMessages.push({ targetId: conn.id, event, payload, livething });
    },
    sendThroughPipeline: (
      conn: RuntimeConnection,
      { routing, event, payload }: SendThroughPipelineOptions,
    ) => {
      pipelineSends.push({ event, payload, routing, targetId: conn.id });
      return true;
    },
    openSharedSend: ({ routing, event, payload }: SharedSendOptions) => ({
      deliver(conn: RuntimeConnection) {
        pipelineSends.push({ event, payload, routing, targetId: conn.id });
        return true;
      },
      finish() {},
    }),
    broadcastToConnections: (
      targets: readonly RuntimeConnection[],
      opts: { event: string; payload: unknown },
    ) => {
      broadcasts.push({ targets, event: opts.event, payload: opts.payload });
    },
    persistAttachment: vi.fn(),
    logger: { warn: vi.fn() },
    errorHooks: [] as readonly ((
      ctx: unknown,
      error: unknown,
      event?: string,
    ) => void | Promise<void>)[],
    handleRuntimeError: vi.fn(async () => {}),
  };

  return { runtime, protocolMessages, pipelineSends, broadcasts };
}

function wireChunks(
  connection: RuntimeConnection,
): { event: string; __livething: Record<string, unknown> }[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((connection.descriptor.send as any).mock.calls as [{ text: string }][]).map(([wire]) => {
    const [event, , metadata] = JSON.parse(wire.text) as [
      string,
      unknown,
      Record<string, unknown> | null,
    ];
    const stream = metadata?.stream as { seq?: number } | undefined;
    return { event, __livething: { streamSeq: stream?.seq } };
  });
}

function baseDef(overrides: Partial<DurableStreamRuntimeDef> = {}): DurableStreamRuntimeDef {
  return {
    event: 'e',
    allowConcurrent: false,
    maxAgeMs: 60_000,
    retentionAfterEndMs: 30_000,
    generator: async function* () {} as never,
    ...overrides,
  };
}

describe('durable stream runtime', () => {
  it('recorded stream — completes cleanly, marks the row ended, sends __streamEnd__', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeDefined();
    const end = protocolMessages.find((m) => m.event === '__streamEnd__');
    expect(end?.livething.streamSeq).toBe(2);

    const row = Storage.readStream(sql, 'u1', 'gen-1');
    expect(row?.status).toBe('ended');
    expect(
      Storage.readChunksSince(sql, { userId: 'u1', streamId: 'gen-1', since: 0 }),
    ).toHaveLength(2);
  });

  it('removes a new durable row when the start frame throws', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();
    runtime.sendProtocolMessage = () => {
      throw new LiveThingConfigError('adapter send is misconfigured');
    };

    await expect(
      runDurableStream(runtime as never, connection, {
        scope: {},
        def: baseDef(),
        payload: {},
        livething: { streamId: 'failed-start' } as never,
      }),
    ).rejects.toThrow(LiveThingConfigError);

    expect(Storage.readStream(sql, 'u1', 'failed-start')).toBeNull();
  });

  it('keeps recording when the owner socket refuses a chunk, and ends without a frame to it', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();
    runtime.sendThroughPipeline = vi.fn(() => false);

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    expect(runtime.sendThroughPipeline).toHaveBeenCalledTimes(1);
    expect(protocolMessages.some((message) => message.event === '__streamEnd__')).toBe(false);
    expect(Storage.readStream(sql, 'u1', 'gen-1')?.status).toBe('ended');
    expect(
      Storage.readChunksSince(sql, { userId: 'u1', streamId: 'gen-1', since: 0 }),
    ).toHaveLength(2);
  });

  it('does not start a durable generator after its start frame closes the connection', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();
    runtime.sendProtocolMessage = vi.fn(() => {
      connection.closing = true;
    });

    let generatorStarted = false;

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        generator: async function* () {
          generatorStarted = true;
          yield { i: 1 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    expect(generatorStarted).toBe(false);
    expect(Storage.readStream(sql, 'u1', 'gen-1')).toBeNull();
  });

  it('recorded stream — yield throws StreamAborted({reason:"buffer-full"}) when cap is hit', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    let caughtReason: string | null = null;
    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        maxChunks: 2,
        generator: async function* () {
          for (let i = 1; i <= 5; i += 1) {
            try {
              yield { i };
            } catch (err) {
              if (StreamAborted.matches(err)) {
                caughtReason = err.detail.reason;
                return;
              }

              throw err;
            }
          }
        },
      }),
      payload: {},
      livething: undefined,
    });

    expect(caughtReason).toBe('buffer-full');
    // The chunk that went over the limit is neither stored nor sent, and the end frame's seq is
    // the last chunk the client got, so a client checking for gaps ends cleanly.
    const chunkRows = Storage.readChunksSince(sql, { userId: 'u1', streamId: 'gen-1', since: 0 });
    expect(chunkRows.map((row) => row.seq)).toEqual([1, 2]);
    expect(
      pipelineSends.map((send) => (send.routing as { streamSeq?: number } | undefined)?.streamSeq),
    ).toEqual([1, 2]);
    const end = protocolMessages.find((m) => m.event === '__streamEnd__');
    expect((end?.livething as { streamSeq?: number } | undefined)?.streamSeq).toBe(2);

    expect(Storage.readStream(sql, 'u1', 'gen-1')?.lastSeq).toBe(2);
  });

  it('cancelDurableStream — deletes row + chunks immediately', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: Date.now(),
      maxChunks: 10,
    });
    Storage.appendChunk(sql, {
      userId: 'u1',
      streamId: 's-1',
      seq: 1,
      messageId: null,
      payload: '{}',
    });

    await cancelDurableStream(runtime as never, connection, { streamId: 's-1', cancelScope: {} });

    expect(Storage.readStream(sql, 'u1', 's-1')).toBeNull();
    expect(Storage.readChunksSince(sql, { userId: 'u1', streamId: 's-1', since: 0 })).toEqual([]);
  });

  it('a reconnect that arrives while a cancel is still running gets not-found', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: Date.now(),
    });

    // The generator is parked in an await, so its cleanup finishes later.
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    runtime.activeStreams.set('s-1', {
      id: 's-1',
      closed: false,
      generator: { return: () => cleanup.then(() => ({ value: undefined, done: true })) },
    } as unknown as ActiveStream);

    const generator = vi.fn(async function* () {
      yield { idx: 1 };
    });

    // The dispatcher records the running cancel on the connection.
    const cancelling = cancelDurableStream(runtime as never, connection, {
      streamId: 's-1',
      cancelScope: {},
    });
    connection.cancellingStreams = new Map([['s-1', cancelling]]);
    const continuing = continueDurableStream(runtime as never, connection, {
      resolveDef: () => ({ scope: {}, def: baseDef({ generator }) }),
      row: Storage.readStream(sql, 'u1', 's-1'),
      streamId: 's-1',
      lastKnownSeq: 0,
    });
    finishCleanup();
    await Promise.all([cancelling, continuing]);

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(protocolMessages.some((m) => m.event === '__streamOk__')).toBe(false);
    expect(generator).not.toHaveBeenCalled();
    expect(Storage.readStream(sql, 'u1', 's-1')).toBeNull();
  });

  it('continueDurableStream — unknown stream id surfaces stream-aborted not-found', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    await continueDurableStream(runtime as never, connection, {
      resolveDef: () => undefined,
      row: null,
      streamId: 'missing',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(err?.livething.streamId).toBe('missing');
  });

  it('continueDurableStream — adopts a generator still attached to a half-open old connection', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const oldConnection = createConnection('c-old');
    const connection = createConnection('c-new');

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 'busy',
      event: 'e',
      payload: '{}',
      now: Date.now(),
    });
    Storage.appendChunk(sql, {
      userId: 'u1',
      streamId: 'busy',
      seq: 1,
      messageId: null,
      payload: JSON.stringify({ i: 1 }),
    });

    // The old socket died without a close frame, so its generator still runs
    // attached to it.
    const returnSpy = vi.fn(async () => ({ value: undefined, done: true as const }));
    const live = {
      id: 'busy',
      connectionId: oldConnection.id,
      connection: oldConnection,
      closed: false,
      generator: { return: returnSpy } as never,
    } as unknown as ActiveStream;
    runtime.activeStreams.set('busy', live);

    await continueDurableStream(runtime as never, connection, {
      resolveDef: () => ({ scope: {}, def: baseDef() }),
      row: Storage.readStream(sql, 'u1', 'busy'),
      streamId: 'busy',
      lastKnownSeq: 0,
    });

    expect(returnSpy).not.toHaveBeenCalled();
    expect(live.connection).toBe(connection);
    expect(live.closed).toBe(false);
    // The server cannot tell a half-open socket from a healthy tab, so the old one is told too.
    const errors = protocolMessages.filter((m) => m.event === '__error__');
    expect(errors.map((m) => m.targetId)).toEqual(['c-old']);
    expect(errors[0]?.payload).toMatchObject({ detail: { reason: 'taken-over' } });
    expect(protocolMessages.find((m) => m.event === '__streamOk__')?.targetId).toBe('c-new');

    expect(wireChunks(connection).map((f) => f.__livething.streamSeq)).toEqual([1]);
  });

  it('a superseded run does not suspend or end the replacement row', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    // The generator parks after the first yield; we swap in a replacement
    // ActiveStream while it's parked, then release it.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let yielded!: () => void;
    const firstYield = new Promise<void>((resolve) => {
      yielded = resolve;
    });

    const run = runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        generator: async function* () {
          yield { i: 1 };
          yielded();
          await parked;
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: { streamId: 'shared', channelFamily: null },
    });

    await firstYield;

    // A reconnect swaps the live ActiveStream for this streamId and re-attaches it
    // to the same connection. The parked run must not touch it afterward.
    const replacement = { id: 'shared', closed: false } as unknown as ActiveStream;
    runtime.activeStreams.set('shared', replacement);
    connection.activeStreamIds = new Set(['shared']);

    release();
    await run;

    const row = Storage.readStream(sql, 'u1', 'shared');
    expect(row?.status).toBe('active');
    expect(runtime.activeStreams.get('shared')).toBe(replacement);
  });

  it('a superseded run does not remove the replacement attachment', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let yielded!: () => void;
    const firstYield = new Promise<void>((resolve) => {
      yielded = resolve;
    });

    const run = runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        generator: async function* () {
          yield { i: 1 };
          yielded();
          await parked;
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: { streamId: 'shared', channelFamily: null },
    });

    await firstYield;

    const replacement = { id: 'shared', closed: false } as unknown as ActiveStream;
    runtime.activeStreams.set('shared', replacement);
    connection.activeStreamIds = new Set(['shared']);
    (runtime.persistAttachment as ReturnType<typeof vi.fn>).mockClear();

    release();
    await run;

    // The replacement's attachment must survive: the streamId stays in the set
    // and the superseded run never persists a stale attachment over it.
    expect(connection.activeStreamIds.has('shared')).toBe(true);
    expect(runtime.persistAttachment).not.toHaveBeenCalled();
  });

  it('a superseded recorded generator cannot emit a chunk after replacement', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let yielded!: () => void;
    const firstYield = new Promise<void>((resolve) => {
      yielded = resolve;
    });

    const run = runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        maxChunks: 100,
        generator: async function* () {
          yield { i: 1 };
          yielded();
          await parked;
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: { streamId: 'shared', channelFamily: null },
    });

    await firstYield;

    const replacement = { id: 'shared', closed: false } as unknown as ActiveStream;
    runtime.activeStreams.set('shared', replacement);

    release();
    await run;

    const sentValues = pipelineSends.map((s) => (s.payload as { i: number }).i);
    expect(sentValues).toEqual([1]);
  });

  it('continueDurableStream — recorded stream replays missed chunks since `since` then _streamEnd', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-replay',
      event: 'e',
      payload: '{}',
      now: Date.now(),
      maxChunks: 10,
    });
    for (let seq = 1; seq <= 5; seq += 1) {
      Storage.appendChunk(sql, {
        userId: 'u1',
        streamId: 's-replay',
        seq,
        messageId: `m-${seq}`,
        payload: JSON.stringify({ i: seq }),
      });
    }

    Storage.markEnded(sql, { userId: 'u1', streamId: 's-replay', now: Date.now() });

    await continueDurableStream(runtime as never, connection, {
      resolveDef: () => ({ scope: {}, def: baseDef() }),
      row: Storage.readStream(sql, 'u1', 's-replay'),
      streamId: 's-replay',
      lastKnownSeq: 2,
    });

    const replayed = wireChunks(connection).filter((f) => f.event === 'e');
    expect(replayed.map((f) => f.__livething.streamSeq)).toEqual([3, 4, 5]);
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeDefined();
  });

  it('continueDurableStream — a non-member continuing an expired row gets not-found and the row stays', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const longAgo = Date.now() - 60_000;
    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-old',
      event: 'e',
      payload: '{}',
      now: longAgo,
      maxAgeMs: 1_000,
    });

    Storage.markSuspended(sql, { userId: 'u1', streamId: 's-old', now: longAgo });

    await continueDurableStream(runtime as never, createConnection('c2', 'u2'), {
      resolveDef: () => undefined,
      row: Storage.readStream(sql, 'u1', 's-old'),
      streamId: 's-old',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(Storage.readStream(sql, 'u1', 's-old')).not.toBeNull();
  });

  it('continueDurableStream — suspended row past maxAgeMs surfaces stream-aborted expired and deletes the row', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    const longAgo = Date.now() - 60_000;
    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-old',
      event: 'e',
      payload: '{}',
      now: longAgo,
      maxAgeMs: 1_000,
    });
    Storage.markSuspended(sql, { userId: 'u1', streamId: 's-old', now: longAgo });

    await continueDurableStream(runtime as never, connection, {
      resolveDef: () => ({ scope: {}, def: baseDef() }),
      row: Storage.readStream(sql, 'u1', 's-old'),
      streamId: 's-old',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('expired');
    expect(Storage.readStream(sql, 'u1', 's-old')).toBeNull();
  });

  it('continueDurableStream — ended row past retentionAfterEndMs surfaces stream-aborted not-found and deletes the row', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    const longAgo = Date.now() - 60_000;
    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-ended-old',
      event: 'e',
      payload: '{}',
      now: longAgo,
      retentionAfterEndMs: 500,
    });
    Storage.markEnded(sql, { userId: 'u1', streamId: 's-ended-old', now: longAgo });

    await continueDurableStream(runtime as never, connection, {
      resolveDef: () => ({ scope: {}, def: baseDef() }),
      row: Storage.readStream(sql, 'u1', 's-ended-old'),
      streamId: 's-ended-old',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(Storage.readStream(sql, 'u1', 's-ended-old')).toBeNull();
  });

  it('nudges — populates nudgeValidators on the active stream', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    // A gate that holds the generator open so the assertion can run while
    // the stream is mid-flight.
    function noop(): void {}

    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        nudges: [
          { event: 'pause', validator: undefined },
          { event: 'speed', validator: undefined },
        ],
        generator: async function* () {
          yield { i: 1 };
          await gate;
        },
      }),
      payload: {},
      livething: undefined,
    });

    // Yield to the runtime so the first chunk emits and the active row
    // settles before the assertion.
    await new Promise((r) => setTimeout(r, 10));

    expect(runtime.activeStreams.size).toBe(1);
    const active = [...runtime.activeStreams.values()][0]!;
    expect(active.nudgeValidators.has('pause')).toBe(true);
    expect(active.nudgeValidators.has('speed')).toBe(true);

    release();
    await run;
  });

  it('nudges — buffered nudges land in the generator on the next yield', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    function noop(): void {}

    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen: { event: string; payload: unknown }[] = [];

    const run = runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        nudges: [{ event: 'pause', validator: undefined }],
        generator: async function* (ctx: any) {
          yield { i: 1 };
          await gate;
          const value = yield { i: 2 };
          seen = ctx.nudges(value);
        },
      }),
      payload: {},
      livething: undefined,
    });

    // Wait until the generator is parked in `await gate` — first chunk has
    // emitted and iter.next() is in flight waiting for the gate to release.
    await new Promise((r) => setTimeout(r, 10));

    const active = [...runtime.activeStreams.values()][0]!;
    active.nudges.push({ event: 'pause', payload: undefined });

    release();
    await run;

    expect(seen.some((n) => n.event === 'pause')).toBe(true);
  });

  it('broadcast recordedStream — row keyed by scope, chunks fan out to peers', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends, protocolMessages } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    const peer = createConnection('c-peer', 'u-peer');

    runtime.connections.set(creator.id, creator);
    runtime.connections.set(peer.id, peer);

    await runDurableStream(runtime as never, creator, {
      scope: {},
      def: baseDef({
        broadcast: true,
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    // Row is keyed by broadcast scope key (top-level here), not the
    // creator's user id.
    expect(Storage.readStream(sql, 'u-creator', 'gen-1')).toBeNull();
    const row = Storage.readStream(sql, '__bcast:top__', 'gen-1');
    expect(row).not.toBeNull();
    expect(row!.broadcast).toBe(true);
    expect(row!.creatorUserId).toBe('u-creator');

    // Both chunks were sent to the peer and creator through the outgoing
    // pipeline, which carries protocol metadata in the routing argument.
    // One pipeline send per chunk per recipient: 2 chunks × 2 recipients = 4.
    expect(pipelineSends.filter((p) => p.event === 'e')).toHaveLength(4);
    expect(protocolMessages.filter((m) => m.event === '__streamEnd__')).toHaveLength(2);
  });

  it('broadcast recordedStream — a generator error fans a terminal __error__ to peers, not __streamEnd__', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    const peer = createConnection('c-peer', 'u-peer');

    runtime.connections.set(creator.id, creator);
    runtime.connections.set(peer.id, peer);

    await runDurableStream(runtime as never, creator, {
      scope: {},
      def: baseDef({
        broadcast: true,
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          throw new Error('boom');
        },
      }),
      payload: {},
      livething: undefined,
    });

    expect(runtime.handleRuntimeError).toHaveBeenCalledWith(
      creator,
      expect.objectContaining({ routing: expect.objectContaining({ streamTerminated: true }) }),
    );
    const peerError = protocolMessages.find((m) => m.event === '__error__');
    expect(peerError).toBeDefined();
    expect(peerError!.livething).toMatchObject({ streamTerminated: true });
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeUndefined();
  });

  it('broadcast recordedStream — late joiner continue replays from the scope-keyed buffer', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 'b-1',
      event: 'e',
      payload: '{}',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
      maxChunks: 10,
    });
    for (let seq = 1; seq <= 3; seq += 1) {
      Storage.appendChunk(sql, {
        userId: '__bcast:top__',
        streamId: 'b-1',
        seq,
        messageId: null,
        payload: JSON.stringify({ i: seq }),
      });
    }

    Storage.updateLastSeq(sql, {
      userId: '__bcast:top__',
      streamId: 'b-1',
      lastSeq: 3,
      now: Date.now(),
    });

    const row = Storage.readStream(sql, '__bcast:top__', 'b-1');
    // The creator's generator is still running.
    runtime.activeStreams.set('b-1', { id: 'b-1', closed: false } as unknown as ActiveStream);

    await continueDurableStream(runtime as never, peer, {
      resolveDef: () => ({ scope: {}, def: baseDef({ broadcast: true }) }),
      row,
      streamId: 'b-1',
      lastKnownSeq: 1,
    });

    const replayed = wireChunks(peer).filter((f) => f.event === 'e');
    expect(replayed.map((f) => f.__livething.streamSeq)).toEqual([2, 3]);
    // The generator is still running, so the end arrives later via the broadcast.
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeUndefined();
  });

  it('broadcast recordedStream — a late-joining peer only gets chunks produced after it caught up', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    const peer = createConnection('c-peer', 'u-peer');

    runtime.connections.set(creator.id, creator);

    await runDurableStream(runtime as never, creator, {
      scope: {},
      def: baseDef({
        broadcast: true,
        maxChunks: 10,
        generator: async function* () {
          for (let i = 1; i <= 4; i += 1) {
            if (i === 3) {
              runtime.connections.set(peer.id, peer);
              Storage.setCaughtUpSeq(sql, {
                storageUserId: '__bcast:top__',
                streamId: 'gen-1',
                subscriberUserId: 'u-peer',
                caughtUpSeq: 2,
              });
            }

            yield { i };
          }
        },
      }),
      payload: {},
      livething: undefined,
    });

    const peerSeqs = pipelineSends
      .filter((p) => p.event === 'e' && p.targetId === 'c-peer')
      .map((p) => (p.routing as { streamSeq: number }).streamSeq);
    expect(peerSeqs).toEqual([3, 4]);
  });

  it('broadcast cancel — non-creator unsubscribes self, source keeps running', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-c',
      event: 'e',
      payload: '{}',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
      maxChunks: 10,
    });

    await cancelDurableStream(runtime as never, peer, { streamId: 's-c', cancelScope: {} });

    expect(Storage.readStream(sql, '__bcast:top__', 's-c')).not.toBeNull();
    expect(
      Storage.isUnsubscribed(sql, {
        storageUserId: '__bcast:top__',
        streamId: 's-c',
        subscriberUserId: 'u-peer',
      }),
    ).toBe(true);
  });

  it('broadcast cancel — creator kills the source for everyone', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-d',
      event: 'e',
      payload: '{}',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
      maxChunks: 10,
    });

    await cancelDurableStream(runtime as never, creator, { streamId: 's-d', cancelScope: {} });

    expect(Storage.readStream(sql, '__bcast:top__', 's-d')).toBeNull();
  });

  it('broadcast continue — unsubscribed user gets stream-aborted unsubscribed', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-e',
      event: 'e',
      payload: '{}',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
      maxChunks: 10,
    });
    Storage.markUnsubscribed(sql, {
      storageUserId: '__bcast:top__',
      streamId: 's-e',
      subscriberUserId: 'u-peer',
      now: Date.now(),
    });

    const row = Storage.readStream(sql, '__bcast:top__', 's-e');
    await continueDurableStream(runtime as never, peer, {
      resolveDef: () => ({ scope: {}, def: baseDef({ broadcast: true }) }),
      row,
      streamId: 's-e',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('unsubscribed');
  });

  it('recorded stream —disconnect leaves the active stream in place and marks it detached', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    function noopRelease(): void {}

    let release: () => void = noopRelease;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          await gate;
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.activeStreams.size).toBe(1);
    const live = [...runtime.activeStreams.values()][0]!;

    // Simulate the disconnect hook: the recorded entry stays put, detached
    // flag flips on, generator is NOT returned.
    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, connection.id);
    expect(runtime.activeStreams.has(live.id)).toBe(true);
    expect(live.detached).toBe(true);
    expect(live.closed).toBe(false);

    release();
    await run;
  });

  it('recorded stream —finishing while detached does not send a terminal frame to the stale connection', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection('c-orig', 'u1');

    function noopRelease(): void {}

    let release: () => void = noopRelease;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          await gate;
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));
    const live = [...runtime.activeStreams.values()][0]!;
    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, connection.id);
    expect(live.detached).toBe(true);

    protocolMessages.length = 0;
    release();
    await run;

    expect(protocolMessages).toEqual([]);
    expect(Storage.readStream(sql, 'u1', live.id)?.status).toBe('ended');
  });

  it('recorded stream —continue from a fresh connection swaps the wire target and replays the buffer', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const original = createConnection('c-orig', 'u1');
    const reconnect = createConnection('c-new', 'u1');

    function noopRelease(): void {}

    let release: () => void = noopRelease;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runDurableStream(runtime as never, original, {
      scope: {},
      def: baseDef({
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
          await gate;
          yield { i: 3 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));
    const live = [...runtime.activeStreams.values()][0]!;

    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, original.id);
    expect(live.detached).toBe(true);

    const sentBeforeContinue = pipelineSends.length;

    await continueDurableStream(runtime as never, reconnect, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          maxChunks: 10,
          generator: async function* () {} as never,
        }),
      }),
      row: Storage.readStream(sql, 'u1', live.id),
      streamId: live.id,
      lastKnownSeq: 0,
    });

    const okFrames = protocolMessages.filter(
      (m) => m.event === '__streamOk__' && m.livething.streamId === live.id,
    );
    expect(okFrames.length).toBeGreaterThanOrEqual(1);
    const replayed = wireChunks(reconnect).filter((f) => f.event === 'e');
    expect(replayed.map((f) => f.__livething.streamSeq)).toEqual([1, 2]);

    expect(live.detached).toBe(false);
    expect(live.connection?.id).toBe('c-new');
    expect(live.connectionId).toBe('c-new');

    release();
    await run;

    // The third chunk produced after continue goes through sendThroughPipeline
    // (wireTarget = live.connection = c-new), not the stale c-orig.
    const sentAfterContinue = pipelineSends.length;
    expect(sentAfterContinue).toBeGreaterThan(sentBeforeContinue);
  });

  it('keeps a stream detached when replay chunks fail during creator continue', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const original = createConnection('c-orig', 'u1');
    const reconnect = createConnection('c-new', 'u1');

    reconnect.descriptor.send = vi.fn(() => false);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = runDurableStream(runtime as never, original, {
      scope: {},
      def: baseDef({
        generator: async function* () {
          yield { i: 1 };
          await gate;
        },
      }),
      payload: {},
      livething: undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const live = [...runtime.activeStreams.values()][0]!;
    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, original.id);

    await continueDurableStream(runtime as never, reconnect, {
      resolveDef: () => ({
        scope: {},
        def: baseDef(),
      }),
      row: Storage.readStream(sql, 'u1', live.id),
      streamId: live.id,
      lastKnownSeq: 0,
    });

    expect(live.detached).toBe(true);
    expect(live.connection?.id).toBe('c-orig');
    expect(reconnect.activeStreamIds?.has(live.id)).toBe(false);

    release();
    await run;
  });

  it('keeps a stream detached when creator continue confirmation throws', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const original = createConnection('c-orig', 'u1');
    const reconnect = createConnection('c-new', 'u1');

    runtime.sendProtocolMessage = () => {
      throw new LiveThingConfigError('adapter send is misconfigured');
    };

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 'continue-failure',
      event: 'e',
      payload: '{}',
      now: Date.now(),
      maxChunks: 10,
    });
    const live = {
      id: 'continue-failure',
      connection: original,
      connectionId: original.id,
      detached: true,
    } as ActiveStream;
    runtime.activeStreams.set(live.id, live);

    await expect(
      continueDurableStream(runtime as never, reconnect, {
        resolveDef: () => ({ scope: {}, def: baseDef() }),
        row: Storage.readStream(sql, 'u1', live.id),
        streamId: live.id,
        lastKnownSeq: 0,
      }),
    ).rejects.toThrow(LiveThingConfigError);

    expect(live.detached).toBe(true);
    expect(live.connection?.id).toBe(original.id);
    expect(reconnect.activeStreamIds?.has(live.id)).toBe(false);
    expect(runtime.persistAttachment).toHaveBeenLastCalledWith(reconnect, { force: true });
  });

  it('recorded stream —after continue, final __streamEnd__ targets the fresh connection and clears its attachment', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const original = createConnection('c-orig', 'u1');
    const reconnect = createConnection('c-new', 'u1');

    function noopRelease(): void {}

    let release: () => void = noopRelease;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runDurableStream(runtime as never, original, {
      scope: {},
      def: baseDef({
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          await gate;
          yield { i: 2 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));
    const live = [...runtime.activeStreams.values()][0]!;
    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, original.id);
    original.closing = true;

    await continueDurableStream(runtime as never, reconnect, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          maxChunks: 10,
          generator: async function* () {} as never,
        }),
      }),
      row: Storage.readStream(sql, 'u1', live.id),
      streamId: live.id,
      lastKnownSeq: 0,
    });

    protocolMessages.length = 0;
    release();
    await run;

    const end = protocolMessages.find(
      (message) => message.event === '__streamEnd__' && message.livething.streamId === live.id,
    );
    expect(end?.targetId).toBe(reconnect.id);
    expect(Storage.readStream(sql, 'u1', live.id)?.status).toBe('ended');
  });

  it('synchronous throw while creating the generator marks the row ended (not stuck active)', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        generator: (() => {
          throw new Error('generator factory blew up');
        }) as never,
      }),
      payload: {},
      livething: undefined,
    });

    expect(Storage.readStream(sql, 'u1', 'gen-1')?.status).toBe('ended');
    expect(runtime.activeStreams.has('gen-1')).toBe(false);
    expect(connection.activeStreamIds?.has('gen-1')).toBeFalsy();
  });

  it('LiveThingConfigError during iteration marks the row ended then rethrows', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    await expect(
      runDurableStream(runtime as never, connection, {
        scope: {},
        def: baseDef({
          generator: async function* () {
            yield { i: 1 };
            throw new LiveThingConfigError('bad stream config');
          },
        }),
        payload: {},
        livething: undefined,
      }),
    ).rejects.toBeInstanceOf(LiveThingConfigError);

    expect(Storage.readStream(sql, 'u1', 'gen-1')?.status).toBe('ended');
    expect(runtime.activeStreams.has('gen-1')).toBe(false);
  });

  it('ctx.stream.signal — durable generator sees an AbortSignal that fires with the cancel reason', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    function noop(): void {}

    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let signalAtStart: AbortSignal | undefined;
    let abortedReason: unknown;

    const run = runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        maxChunks: 10,
        generator: wrapStreamGenerator(async function* (c: any) {
          signalAtStart = c.stream.signal;
          c.stream.signal.addEventListener('abort', () => {
            abortedReason = c.stream.signal.reason;
          });
          yield { i: 1 };
          await gate;
          yield { i: 2 };
        }) as never,
      }),
      payload: {},
      livething: { streamId: 's-sig', channelFamily: null },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(signalAtStart).toBeInstanceOf(AbortSignal);
    expect(signalAtStart!.aborted).toBe(false);

    const cancelled = cancelDurableStream(runtime as never, connection, {
      streamId: 's-sig',
      cancelScope: {},
    });

    expect(signalAtStart!.aborted).toBe(true);
    expect(abortedReason).toBe('cancelled');

    release();
    await cancelled;
    await run;
  });

  it('ctx.stream.drain — durable generator can call drain and it resolves', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    let drainResolved = false;

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        maxChunks: 10,
        generator: wrapStreamGenerator(async function* (c: any) {
          yield { i: 1 };
          await c.stream.drain();
          drainResolved = true;
          yield { i: 2 };
        }) as never,
      }),
      payload: {},
      livething: { streamId: 's-drain', channelFamily: null },
    });

    expect(drainResolved).toBe(true);
    expect(pipelineSends.filter((p) => p.event === 'e')).toHaveLength(2);
  });

  it('broadcast recordedStream — two anonymous subscribers get isolated storage rows, keyed by connection id', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    const anonA = createConnection('c-anon-a', '');

    const anonB = createConnection('c-anon-b', '');
    runtime.connections.set(creator.id, creator);
    runtime.connections.set(anonA.id, anonA);
    runtime.connections.set(anonB.id, anonB);

    await runDurableStream(runtime as never, creator, {
      scope: {},
      def: baseDef({
        broadcast: true,
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    // Each anonymous connection is its own subscriber row, keyed by its own
    // connection id — not collapsed onto a single '' row that both would share.
    const subA = Storage.getSubscriber(sql, {
      storageUserId: '__bcast:top__',
      streamId: 'gen-1',
      subscriberUserId: 'c-anon-a',
    });
    const subB = Storage.getSubscriber(sql, {
      storageUserId: '__bcast:top__',
      streamId: 'gen-1',
      subscriberUserId: 'c-anon-b',
    });
    expect(subA).not.toBeNull();
    expect(subB).not.toBeNull();

    // Unsubscribing one anonymous connection must not affect the other.
    Storage.markUnsubscribed(sql, {
      storageUserId: '__bcast:top__',
      streamId: 'gen-1',
      subscriberUserId: 'c-anon-a',
      now: Date.now(),
    });
    expect(
      Storage.isUnsubscribed(sql, {
        storageUserId: '__bcast:top__',
        streamId: 'gen-1',
        subscriberUserId: 'c-anon-a',
      }),
    ).toBe(true);
    expect(
      Storage.isUnsubscribed(sql, {
        storageUserId: '__bcast:top__',
        streamId: 'gen-1',
        subscriberUserId: 'c-anon-b',
      }),
    ).toBe(false);
  });

  it('runDurableStream refuses an anonymous creator', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const anon = createConnection('c-anon', '');

    await expect(
      runDurableStream(runtime as never, anon, {
        scope: {},
        def: baseDef(),
        payload: {},
        livething: undefined,
      }),
    ).rejects.toThrow();
  });

  it('an identified connection continuing after a reconnect (new connection id, same user id) still finds its own row', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime: creatorRuntime } = createRuntime(sql);
    const original = createConnection('c-original', 'u-alice');
    creatorRuntime.connections.set(original.id, original);

    await runDurableStream(creatorRuntime as never, original, {
      scope: {},
      def: baseDef({
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
        },
      }),
      payload: {},
      livething: { streamId: 'reconnect-1', channelFamily: null },
    });

    const { runtime: continueRuntime, protocolMessages } = createRuntime(sql);
    const reconnected = createConnection('c-reconnected', 'u-alice');
    continueRuntime.connections.set(reconnected.id, reconnected);

    const row = Storage.readStream(sql, 'u-alice', 'reconnect-1');
    await continueDurableStream(continueRuntime as never, reconnected, {
      resolveDef: () => ({ scope: {}, def: baseDef() }),
      row,
      streamId: 'reconnect-1',
      lastKnownSeq: 0,
    });

    expect(protocolMessages.find((m) => m.event === '__error__')).toBeUndefined();
  });
});

describe('recorded stream cut off before it finished', () => {
  const interrupted = {
    event: '__error__',
    payload: { code: 'stream-aborted', detail: { reason: 'interrupted' } },
  };

  function replyDef(generator?: DurableStreamRuntimeDef['generator']): DurableStreamRuntimeDef {
    return baseDef({ event: 'generate-reply', broadcast: false, generator });
  }

  function sentSeqs(connection: RuntimeConnection): unknown[] {
    return wireChunks(connection)
      .filter((frame) => frame.event === 'generate-reply')
      .map((frame) => frame.__livething.streamSeq);
  }

  it('after a server restart, continue replays the saved chunks then reports interrupted', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const before = createRuntime(sql);
    const owner = createConnection('c-owner', 'u1');

    let fourSent!: () => void;
    const fourChunks = new Promise<void>((resolve) => {
      fourSent = resolve;
    });
    void runDurableStream(before.runtime as never, owner, {
      scope: {},
      def: replyDef(async function* () {
        for (let i = 1; i <= 4; i += 1) yield { token: `t${i}` };
        fourSent();
        await new Promise<never>(() => {});
      }),
      payload: {},
      livething: { streamId: 's1' } as never,
    });
    await fourChunks;

    // The process stops: its generator is gone, and the next boot suspends the row.
    Storage.suspendOrphanedStreams(sql, Date.now());
    const after = createRuntime(sql);
    const reconnected = createConnection('c-reconnected', 'u1');

    await continueDurableStream(after.runtime as never, reconnected, {
      resolveDef: () => ({ scope: {}, def: replyDef() }),
      row: Storage.readStream(sql, 'u1', 's1'),
      streamId: 's1',
      lastKnownSeq: 0,
    });

    expect(sentSeqs(reconnected)).toEqual([1, 2, 3, 4]);
    expect(after.protocolMessages.some((m) => m.event === '__streamEnd__')).toBe(false);
    expect(after.protocolMessages).toContainEqual(
      expect.objectContaining({
        ...interrupted,
        targetId: 'c-reconnected',
        livething: expect.objectContaining({ streamId: 's1', streamTerminated: true }),
      }),
    );
    expect(Storage.readStream(sql, 'u1', 's1')).toMatchObject({
      status: 'ended',
      interrupted: true,
    });
  });

  it('a generator that threw while its owner was away is reported as interrupted on continue', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const owner = createConnection('c-owner', 'u1');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = runDurableStream(runtime as never, owner, {
      scope: {},
      def: replyDef(async function* () {
        yield { token: 't1' };
        yield { token: 't2' };
        await gate;
        throw new Error('model provider timed out');
      }),
      payload: {},
      livething: { streamId: 's2' } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, owner.id);

    release();
    await run;

    const reconnected = createConnection('c-reconnected', 'u1');
    await continueDurableStream(runtime as never, reconnected, {
      resolveDef: () => ({ scope: {}, def: replyDef() }),
      row: Storage.readStream(sql, 'u1', 's2'),
      streamId: 's2',
      lastKnownSeq: 0,
    });

    expect(sentSeqs(reconnected)).toEqual([1, 2]);
    const toReconnected = protocolMessages.filter((m) => m.targetId === 'c-reconnected');
    expect(toReconnected.some((m) => m.event === '__streamEnd__')).toBe(false);
    expect(toReconnected).toContainEqual(expect.objectContaining(interrupted));
  });

  it('a stream that really finished still ends normally on continue', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const owner = createConnection('c-owner', 'u1');

    await runDurableStream(runtime as never, owner, {
      scope: {},
      def: replyDef(async function* () {
        yield { token: 't1' };
        yield { token: 't2' };
      }),
      payload: {},
      livething: { streamId: 's3' } as never,
    });

    const reconnected = createConnection('c-reconnected', 'u1');
    await continueDurableStream(runtime as never, reconnected, {
      resolveDef: () => ({ scope: {}, def: replyDef() }),
      row: Storage.readStream(sql, 'u1', 's3'),
      streamId: 's3',
      lastKnownSeq: 0,
    });

    const toReconnected = protocolMessages.filter((m) => m.targetId === 'c-reconnected');
    expect(sentSeqs(reconnected)).toEqual([1, 2]);
    expect(toReconnected.map((m) => m.event)).toEqual(['__streamEnd__']);
  });

  it('broadcast viewers keep getting chunks and the end after the creator drops mid-stream', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    const viewer = createConnection('c-viewer', 'u-viewer');

    runtime.connections.set(creator.id, creator);
    runtime.connections.set(viewer.id, viewer);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = runDurableStream(runtime as never, creator, {
      scope: {},
      def: baseDef({
        event: 'generate-reply',
        broadcast: true,
        generator: async function* () {
          yield { token: 't1' };
          yield { token: 't2' };
          await gate;
          yield { token: 't3' };
          yield { token: 't4' };
        },
      }),
      payload: {},
      livething: { streamId: 's4' } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, creator.id);
    runtime.connections.delete(creator.id);
    release();
    await run;

    const viewerSeqs = pipelineSends
      .filter((send) => send.targetId === 'c-viewer' && send.event === 'generate-reply')
      .map((send) => (send.routing as { streamSeq: number }).streamSeq);
    expect(viewerSeqs).toEqual([1, 2, 3, 4]);
    expect(protocolMessages).toContainEqual(
      expect.objectContaining({ event: '__streamEnd__', targetId: 'c-viewer' }),
    );
    expect(
      protocolMessages.some((m) => m.targetId === 'c-creator' && m.event !== '__streamOk__'),
    ).toBe(false);
  });

  it('a viewer continuing a broadcast stream whose generator stopped gets the chunks then interrupted', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const viewer = createConnection('c-viewer', 'u-viewer');

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's5',
      event: 'generate-reply',
      payload: '{}',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
    });
    for (let seq = 1; seq <= 3; seq += 1) {
      Storage.appendChunk(sql, {
        userId: '__bcast:top__',
        streamId: 's5',
        seq,
        messageId: null,
        payload: JSON.stringify({ token: `t${seq}` }),
      });
    }

    Storage.updateLastSeq(sql, { userId: '__bcast:top__', streamId: 's5', lastSeq: 3, now: 1 });
    Storage.suspendOrphanedStreams(sql, Date.now());

    await continueDurableStream(runtime as never, viewer, {
      resolveDef: () => ({ scope: {}, def: baseDef({ event: 'generate-reply', broadcast: true }) }),
      row: Storage.readStream(sql, '__bcast:top__', 's5'),
      streamId: 's5',
      lastKnownSeq: 1,
    });

    expect(sentSeqs(viewer)).toEqual([2, 3]);
    expect(protocolMessages).toContainEqual(
      expect.objectContaining({ ...interrupted, targetId: 'c-viewer' }),
    );
    expect(Storage.readStream(sql, '__bcast:top__', 's5')).toMatchObject({
      status: 'ended',
      interrupted: true,
    });
  });
});
