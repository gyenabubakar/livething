/* oxlint-disable @typescript-eslint/no-explicit-any */
import { StreamAborted, WSKitConfigError } from '@wskit/core';
import * as ConnectionLifecycle from '~/_engine/runtime/connection.ts';
import { createTestSql } from '~/_test/sql.ts';
import { wrapStreamGenerator } from '~/stream/shared.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveStream, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { SendThroughPipelineOptions } from '~/outgoing/runtime.ts';
import { cancelDurableStream, resumeDurableStream, runDurableStream } from './runtime.ts';
import * as Storage from './storage.ts';
import type { DurableStreamRuntimeDef } from './runtime.ts';

function createConnection(id = 'c1', userId = 'u1'): RuntimeConnection {
  return {
    id,
    userId,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close() {},
      bufferedAmount() {
        return 0;
      },
      userId,
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
    wskit: Record<string, unknown>;
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
    activeStreams: new Map<string, ActiveStream>(),
    connections: new Map<string, RuntimeConnection>(),
    generateId: () => `gen-${++nextStreamId}`,
    buildConnectionContext: () => ({ id: 'ctx', nudges: () => [] }),
    sendProtocolMessage: (
      conn: RuntimeConnection,
      { event, payload, wskit }: SendProtocolMessageOptions,
    ) => {
      protocolMessages.push({ targetId: conn.id, event, payload, wskit });
    },
    sendThroughPipeline: (
      conn: RuntimeConnection,
      { routing, event, payload }: SendThroughPipelineOptions,
    ) => {
      pipelineSends.push({ event, payload, routing, targetId: conn.id });
      return true;
    },
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
): { event: string; __wskit: Record<string, unknown> }[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((connection.descriptor.send as any).mock.calls as [string][]).map(([w]) => JSON.parse(w));
}

function baseDef(overrides: Partial<DurableStreamRuntimeDef> = {}): DurableStreamRuntimeDef {
  return {
    event: 'e',
    kind: 'recorded',
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
        kind: 'recorded',
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
        },
      }),
      payload: {},
      wskit: undefined,
    });

    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeDefined();
    const end = protocolMessages.find((m) => m.event === '__streamEnd__');
    expect(end?.wskit.seq).toBe(2);

    const row = Storage.readStream(sql, 'u1', 'gen-1');
    expect(row?.status).toBe('ended');
    expect(
      Storage.readChunksSince(sql, { userId: 'u1', streamId: 'gen-1', since: 0 }),
    ).toHaveLength(2);
  });

  it('removes a new durable row when the translated start frame throws', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();
    runtime.sendProtocolMessage = () => {
      throw new WSKitConfigError('translator outbound is invalid');
    };

    await expect(
      runDurableStream(runtime as never, connection, {
        scope: {},
        def: baseDef(),
        payload: {},
        wskit: { streamId: 'failed-start' } as never,
      }),
    ).rejects.toThrow(WSKitConfigError);

    expect(Storage.readStream(sql, 'u1', 'failed-start')).toBeNull();
  });

  it('stops a durable stream when its translated connection rejects a chunk', async () => {
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
      wskit: undefined,
    });

    expect(runtime.sendThroughPipeline).toHaveBeenCalledTimes(1);
    expect(protocolMessages.some((message) => message.event === '__streamEnd__')).toBe(false);
    expect(Storage.readStream(sql, 'u1', 'gen-1')?.status).toBe('suspended');
  });

  it('saves a resumable checkpoint before a chunk is handed to the socket', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();
    runtime.sendThroughPipeline = vi.fn(() => false);

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        kind: 'resumable',
        generator: async function* (ctx: any) {
          yield ctx.stream.withCursor({ row: 1 }, { idx: 1 });
        },
      }),
      payload: {},
      wskit: undefined,
    });

    const row = Storage.readStream(sql, 'u1', 'gen-1')!;
    expect(row.lastSeq).toBe(0);
    expect(
      Storage.readCursorCheckpointAtOrBefore(sql, { userId: 'u1', streamId: 'gen-1', seq: 1 }),
    ).toMatchObject({ seq: 1, cursor: JSON.stringify({ idx: 1 }) });
  });

  it('does not send a resumable chunk when its cursor cannot be serialized', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        kind: 'resumable',
        generator: async function* (ctx: any) {
          yield ctx.stream.withCursor({ row: 1 }, { toJSON: () => undefined });
        },
      }),
      payload: {},
      wskit: undefined,
    });

    expect(pipelineSends).toHaveLength(0);
    expect(runtime.handleRuntimeError).toHaveBeenCalledTimes(1);
  });

  it('does not start a durable generator after its translated start frame closes the connection', async () => {
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
      wskit: undefined,
    });

    expect(generatorStarted).toBe(false);
    expect(Storage.readStream(sql, 'u1', 'gen-1')).toBeNull();
  });

  it('recorded stream — yield throws StreamAborted({reason:"buffer-full"}) when cap is hit', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    let caughtReason: string | null = null;
    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        kind: 'recorded',
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
      wskit: undefined,
    });

    expect(caughtReason).toBe('buffer-full');
    const chunkRows = Storage.readChunksSince(sql, { userId: 'u1', streamId: 'gen-1', since: 0 });
    expect(chunkRows.length).toBeLessThanOrEqual(2);
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeDefined();
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
      kind: 'recorded',
      now: Date.now(),
      maxChunks: 10,
    });
    Storage.appendChunk(sql, {
      userId: 'u1',
      streamId: 's-1',
      seq: 1,
      messageId: null,
      payload: '{}',
      now: Date.now(),
    });

    await cancelDurableStream(runtime as never, connection, { streamId: 's-1', cancelScope: {} });

    expect(Storage.readStream(sql, 'u1', 's-1')).toBeNull();
    expect(Storage.readChunksSince(sql, { userId: 'u1', streamId: 's-1', since: 0 })).toEqual([]);
  });

  it('resumeDurableStream — unknown stream id surfaces stream-aborted not-found', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => undefined,
      row: null,
      streamId: 'missing',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(err?.wskit.streamId).toBe('missing');
  });

  it('resumeDurableStream — closes any in-flight generator for the same id and proceeds', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 'busy',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });

    // Pre-load a stale in-memory generator (its socket already dropped, but
    // its `finally` hasn't run yet — for example, it's still parked in an
    // await waiting for a slow upstream to release).
    const returnSpy = vi.fn(async () => ({ value: undefined, done: true as const }));
    runtime.activeStreams.set('busy', {
      id: 'busy',
      closed: false,
      generator: { return: returnSpy } as never,
    } as unknown as ActiveStream);

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* (ctx: any) {
            yield ctx.stream.withCursor({ idx: 1 }, { idx: 1 });
          },
        }),
      }),
      row: Storage.readStream(sql, 'u1', 'busy'),
      streamId: 'busy',
      lastKnownSeq: 0,
    });

    // The stale entry was asked to close; resume continued with a fresh
    // generator run. No __error__ frame, and a __streamOk__ was sent for the
    // re-invocation.
    expect(protocolMessages.find((m) => m.event === '__error__')).toBeUndefined();
    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeDefined();
    expect(returnSpy).toHaveBeenCalled();
  });

  it('an old run that lost its slot to a replacement does not suspend or end the replacement row', async () => {
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
        kind: 'resumable',
        generator: async function* (ctx: any) {
          yield ctx.stream.withCursor({ i: 1 }, { idx: 1 });
          yielded();
          await parked;
          yield ctx.stream.withCursor({ i: 2 }, { idx: 2 });
        },
      }),
      payload: {},
      wskit: { streamId: 'shared', channelFamily: null },
    });

    await firstYield;

    // A resume swaps the live ActiveStream for this streamId and re-attaches it
    // to the same connection. The old parked run must not touch it afterward.
    const replacement = { id: 'shared', closed: false } as unknown as ActiveStream;
    runtime.activeStreams.set('shared', replacement);
    connection.activeStreamIds = new Set(['shared']);

    release();
    await run;

    const row = Storage.readStream(sql, 'u1', 'shared');
    expect(row?.status).toBe('active');
    expect(runtime.activeStreams.get('shared')).toBe(replacement);
  });

  it('an old run that lost its slot does not remove the replacement attachment', async () => {
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
        kind: 'resumable',
        generator: async function* (ctx: any) {
          yield ctx.stream.withCursor({ i: 1 }, { idx: 1 });
          yielded();
          await parked;
          yield ctx.stream.withCursor({ i: 2 }, { idx: 2 });
        },
      }),
      payload: {},
      wskit: { streamId: 'shared', channelFamily: null },
    });

    await firstYield;

    const replacement = { id: 'shared', closed: false } as unknown as ActiveStream;
    runtime.activeStreams.set('shared', replacement);
    connection.activeStreamIds = new Set(['shared']);
    (runtime.persistAttachment as ReturnType<typeof vi.fn>).mockClear();

    release();
    await run;

    // The replacement's attachment must survive: the streamId stays in the set
    // and the old run never persists a stale attachment over it.
    expect(connection.activeStreamIds.has('shared')).toBe(true);
    expect(runtime.persistAttachment).not.toHaveBeenCalled();
  });

  it('an old recorded generator cannot emit a chunk after a replacement takes the slot', async () => {
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
        kind: 'recorded',
        maxChunks: 100,
        generator: async function* () {
          yield { i: 1 };
          yielded();
          await parked;
          yield { i: 2 };
        },
      }),
      payload: {},
      wskit: { streamId: 'shared', channelFamily: null },
    });

    await firstYield;

    const replacement = { id: 'shared', closed: false } as unknown as ActiveStream;
    runtime.activeStreams.set('shared', replacement);

    release();
    await run;

    const sentValues = pipelineSends.map((s) => (s.payload as { i: number }).i);
    expect(sentValues).toEqual([1]);
  });

  it('resumeDurableStream — a corrupt stored payload sends cursor-invalid instead of throwing', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    // A partially-written / corrupt row: payload is not valid JSON.
    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 'corrupt',
      event: 'e',
      payload: '{not valid json',
      kind: 'resumable',
      now: Date.now(),
    });

    await expect(
      resumeDurableStream(runtime as never, connection, {
        resolveDef: () => ({
          scope: {},
          def: baseDef({
            kind: 'resumable',
            generator: async function* () {
              /* never reached — the payload parse fails first */
            },
          }),
        }),
        row: Storage.readStream(sql, 'u1', 'corrupt'),
        streamId: 'corrupt',
        lastKnownSeq: 0,
      }),
    ).resolves.toBeUndefined();

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('cursor-invalid');
    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeUndefined();
  });

  it('resumeDurableStream — recorded stream replays missed chunks since `since` then _streamEnd', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-replay',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
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
        now: Date.now(),
      });
    }

    Storage.markEnded(sql, { userId: 'u1', streamId: 's-replay', now: Date.now() });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({ scope: {}, def: baseDef({ kind: 'recorded' }) }),
      row: Storage.readStream(sql, 'u1', 's-replay'),
      streamId: 's-replay',
      lastKnownSeq: 2,
    });

    const replayed = wireChunks(connection).filter((f) => f.event === 'e');
    expect(replayed.map((f) => f.__wskit.seq)).toEqual([3, 4, 5]);
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeDefined();
  });

  it('resumeDurableStream — resumable stream re-invokes the generator with the saved cursor', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-cursor',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    Storage.updateLastSeq(sql, { userId: 'u1', streamId: 's-cursor', lastSeq: 4, now: Date.now() });
    Storage.appendCursorCheckpoint(sql, {
      userId: 'u1',
      streamId: 's-cursor',
      seq: 4,
      cursor: JSON.stringify({ idx: 4 }),
      now: Date.now(),
    });
    Storage.markSuspended(sql, { userId: 'u1', streamId: 's-cursor', now: Date.now() });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* (ctx: any) {
            const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
            for (let i = startAt + 1; i <= 6; i += 1) {
              yield ctx.stream.withCursor({ i }, { idx: i });
            }
          },
        }),
      }),
      row: Storage.readStream(sql, 'u1', 's-cursor'),
      streamId: 's-cursor',
      lastKnownSeq: 4,
    });

    const sent = pipelineSends.filter((m) => m.event === 'e').map((m) => m.payload);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ i: 5 });
    expect(sent[1]).toMatchObject({ i: 6 });
  });

  it('resumeDurableStream — restarts from the last cursor the client confirms receiving', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-confirmed-cursor',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    for (let seq = 1; seq <= 4; seq += 1) {
      Storage.appendCursorCheckpoint(sql, {
        userId: 'u1',
        streamId: 's-confirmed-cursor',
        seq,
        cursor: JSON.stringify({ idx: seq }),
        now: Date.now(),
      });
    }

    Storage.updateLastSeq(sql, {
      userId: 'u1',
      streamId: 's-confirmed-cursor',
      lastSeq: 4,
      now: Date.now(),
    });
    Storage.markSuspended(sql, {
      userId: 'u1',
      streamId: 's-confirmed-cursor',
      now: Date.now(),
    });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* (ctx: any) {
            const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
            for (let i = startAt + 1; i <= 5; i += 1) {
              yield ctx.stream.withCursor({ i }, { idx: i });
            }
          },
        }),
      }),
      row: Storage.readStream(sql, 'u1', 's-confirmed-cursor'),
      streamId: 's-confirmed-cursor',
      lastKnownSeq: 3,
    });

    const sent = pipelineSends.filter((m) => m.event === 'e').map((m) => m.payload);
    expect(sent).toEqual([{ i: 4 }, { i: 5 }]);
    expect(
      Storage.readCursorCheckpointAtOrBefore(sql, {
        userId: 'u1',
        streamId: 's-confirmed-cursor',
        seq: 99,
      }),
    ).toMatchObject({ seq: 5, cursor: JSON.stringify({ idx: 5 }) });
  });

  it('resumeDurableStream — re-runs an ended resumable stream for chunks the client missed', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-ended-checkpoint',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    for (let seq = 1; seq <= 4; seq += 1) {
      Storage.appendCursorCheckpoint(sql, {
        userId: 'u1',
        streamId: 's-ended-checkpoint',
        seq,
        cursor: JSON.stringify({ idx: seq }),
        now: Date.now(),
      });
    }

    Storage.updateLastSeq(sql, {
      userId: 'u1',
      streamId: 's-ended-checkpoint',
      lastSeq: 4,
      now: Date.now(),
    });
    Storage.markEnded(sql, { userId: 'u1', streamId: 's-ended-checkpoint', now: Date.now() });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* (ctx: any) {
            const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
            for (let i = startAt + 1; i <= 4; i += 1) {
              yield ctx.stream.withCursor({ i }, { idx: i });
            }
          },
        }),
      }),
      row: Storage.readStream(sql, 'u1', 's-ended-checkpoint'),
      streamId: 's-ended-checkpoint',
      lastKnownSeq: 3,
    });

    expect(pipelineSends.filter((m) => m.event === 'e').map((m) => m.payload)).toEqual([{ i: 4 }]);
    expect(protocolMessages.filter((m) => m.event === '__streamEnd__')).toHaveLength(1);
  });

  it('resumeDurableStream — replaces a detached resumable generator from the confirmed checkpoint', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const previousConnection = createConnection('c-previous');
    const connection = createConnection('c-resumed');

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-detached-checkpoint',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    for (let seq = 1; seq <= 4; seq += 1) {
      Storage.appendCursorCheckpoint(sql, {
        userId: 'u1',
        streamId: 's-detached-checkpoint',
        seq,
        cursor: JSON.stringify({ idx: seq }),
        now: Date.now(),
      });
    }

    Storage.updateLastSeq(sql, {
      userId: 'u1',
      streamId: 's-detached-checkpoint',
      lastSeq: 4,
      now: Date.now(),
    });

    const detachedGenerator = (async function* () {
      yield await new Promise<never>(() => {});
    })();
    const detached = {
      id: 's-detached-checkpoint',
      connectionId: previousConnection.id,
      event: 'e',
      generator: detachedGenerator,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
      detached: true,
      connection: previousConnection,
      scope: {},
      abortController: new AbortController(),
    } as ActiveStream;
    runtime.activeStreams.set(detached.id, detached);

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          onDisconnect: 'keep-running',
          generator: async function* (ctx: any) {
            const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
            yield ctx.stream.withCursor({ i: startAt + 1 }, { idx: startAt + 1 });
          },
        }),
      }),
      row: Storage.readStream(sql, 'u1', 's-detached-checkpoint'),
      streamId: 's-detached-checkpoint',
      lastKnownSeq: 3,
    });

    expect(detached.closed).toBe(true);
    expect(detached.connection).toBe(previousConnection);
    expect(pipelineSends.filter((m) => m.event === 'e').map((m) => m.payload)).toEqual([{ i: 4 }]);
  });

  it('resumeDurableStream — resumed run continues seq from row.lastSeq, not from 1', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-seq',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    Storage.updateLastSeq(sql, { userId: 'u1', streamId: 's-seq', lastSeq: 3, now: Date.now() });
    Storage.appendCursorCheckpoint(sql, {
      userId: 'u1',
      streamId: 's-seq',
      seq: 3,
      cursor: JSON.stringify({ idx: 3 }),
      now: Date.now(),
    });
    Storage.markSuspended(sql, { userId: 'u1', streamId: 's-seq', now: Date.now() });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* (ctx: any) {
            const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
            for (let i = startAt + 1; i <= 5; i += 1) {
              yield ctx.stream.withCursor({ i }, { idx: i });
            }
          },
        }),
      }),
      row: Storage.readStream(sql, 'u1', 's-seq'),
      streamId: 's-seq',
      lastKnownSeq: 3,
    });

    const seqs = pipelineSends
      .filter((m) => m.event === 'e')
      .map((m) => (m.routing as { seq: number }).seq);
    expect(seqs).toEqual([4, 5]);
  });

  it('resumeDurableStream — suspended row past maxAgeMs surfaces stream-aborted expired and deletes the row', async () => {
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
      kind: 'resumable',
      now: longAgo,
      maxAgeMs: 1_000,
    });
    Storage.markSuspended(sql, { userId: 'u1', streamId: 's-old', now: longAgo });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({ scope: {}, def: baseDef({ kind: 'resumable' }) }),
      row: Storage.readStream(sql, 'u1', 's-old'),
      streamId: 's-old',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('expired');
    expect(Storage.readStream(sql, 'u1', 's-old')).toBeNull();
  });

  it('resumeDurableStream — ended row past retentionAfterEndMs surfaces stream-aborted not-found and deletes the row', async () => {
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
      kind: 'recorded',
      now: longAgo,
      retentionAfterEndMs: 500,
    });
    Storage.markEnded(sql, { userId: 'u1', streamId: 's-ended-old', now: longAgo });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({ scope: {}, def: baseDef({ kind: 'recorded' }) }),
      row: Storage.readStream(sql, 'u1', 's-ended-old'),
      streamId: 's-ended-old',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(Storage.readStream(sql, 'u1', 's-ended-old')).toBeNull();
  });

  it('resumeDurableStream — saved cursor passes the def.cursor validator and reaches the generator', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-valid',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    Storage.updateLastSeq(sql, { userId: 'u1', streamId: 's-valid', lastSeq: 7, now: Date.now() });
    Storage.appendCursorCheckpoint(sql, {
      userId: 'u1',
      streamId: 's-valid',
      seq: 7,
      cursor: JSON.stringify({ idx: 7 }),
      now: Date.now(),
    });
    Storage.markSuspended(sql, { userId: 'u1', streamId: 's-valid', now: Date.now() });

    function cursorValidator(raw: unknown): { idx: number } {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.idx !== 'number') throw new Error('idx must be a number');

      return { idx: obj.idx };
    }

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          cursor: cursorValidator,
          generator: async function* (ctx: any) {
            const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
            yield ctx.stream.withCursor({ i: startAt + 1 }, { idx: startAt + 1 });
          },
        }),
      }),
      row: Storage.readStream(sql, 'u1', 's-valid'),
      streamId: 's-valid',
      lastKnownSeq: 7,
    });

    const sent = pipelineSends.filter((m) => m.event === 'e').map((m) => m.payload);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ i: 8 });
  });

  it('resumeDurableStream — cursor that fails the validator surfaces stream-aborted cursor-invalid', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 's-bad',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    // Stamp a cursor shape the validator will reject (idx is a string).
    Storage.updateLastSeq(sql, { userId: 'u1', streamId: 's-bad', lastSeq: 4, now: Date.now() });
    Storage.appendCursorCheckpoint(sql, {
      userId: 'u1',
      streamId: 's-bad',
      seq: 4,
      cursor: JSON.stringify({ idx: 'oops' }),
      now: Date.now(),
    });
    Storage.markSuspended(sql, { userId: 'u1', streamId: 's-bad', now: Date.now() });

    // Schema rejects the stored cursor because `idx` is a string.
    const cursorValidator = v.object({ idx: v.number() });

    const generatorSpy = vi.fn(async function* () {
      yield { i: 1 };
    });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          cursor: cursorValidator,
          generator: generatorSpy as never,
        }),
      }),
      row: Storage.readStream(sql, 'u1', 's-bad'),
      streamId: 's-bad',
      lastKnownSeq: 4,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('cursor-invalid');
    expect(err?.wskit.streamId).toBe('s-bad');
    expect(generatorSpy).not.toHaveBeenCalled();

    expect(pipelineSends).toHaveLength(0);
    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeUndefined();
  });

  it('ctx.stream.attempt — is 1 on first run', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        kind: 'resumable',
        generator: async function* (ctx: any) {
          yield ctx.stream.withCursor({ attempt: ctx.stream.attempt }, { idx: 1 });
        },
      }),
      payload: {},
      wskit: undefined,
    });

    expect((pipelineSends[0]!.payload as { attempt: number }).attempt).toBe(1);
  });

  it('ctx.stream.attempt — is 2 on resume', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 'a',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    Storage.markSuspended(sql, { userId: 'u1', streamId: 'a', now: Date.now() });

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* (ctx: any) {
            yield ctx.stream.withCursor({ attempt: ctx.stream.attempt }, { idx: 1 });
          },
        }),
      }),
      row: Storage.readStream(sql, 'u1', 'a'),
      streamId: 'a',
      lastKnownSeq: 0,
    });

    expect((pipelineSends[0]!.payload as { attempt: number }).attempt).toBe(2);
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
        kind: 'recorded',
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
      wskit: undefined,
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
        kind: 'recorded',
        nudges: [{ event: 'pause', validator: undefined }],
        generator: async function* (ctx: any) {
          yield { i: 1 };
          await gate;
          const value = yield { i: 2 };
          seen = ctx.nudges(value);
        },
      }),
      payload: {},
      wskit: undefined,
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
        kind: 'recorded',
        broadcast: true,
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
        },
      }),
      payload: {},
      wskit: undefined,
    });

    // Row is keyed by broadcast scope key (top-level here), not the
    // creator's user id.
    expect(Storage.readStream(sql, 'u-creator', 'gen-1')).toBeNull();
    const row = Storage.readStream(sql, '__bcast:top__', 'gen-1');
    expect(row).not.toBeNull();
    expect(row!.broadcast).toBe(true);
    expect(row!.creatorUserId).toBe('u-creator');

    // Both chunks were sent to the peer via the outgoing pipeline (same as
    // the creator's own copies — broadcastToConnections is no longer used
    // for the chunk fan-out because reserved-field markers must ride the
    // routing arg, not the payload). One pipeline send per chunk per
    // recipient: 2 chunks × 2 recipients = 4 sends.
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
        kind: 'recorded',
        broadcast: true,
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          throw new Error('boom');
        },
      }),
      payload: {},
      wskit: undefined,
    });

    expect(runtime.handleRuntimeError).toHaveBeenCalledWith(
      creator,
      expect.objectContaining({ routing: expect.objectContaining({ streamTerminated: true }) }),
    );
    const peerError = protocolMessages.find((m) => m.event === '__error__');
    expect(peerError).toBeDefined();
    expect(peerError!.wskit).toMatchObject({ streamTerminated: true });
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeUndefined();
  });

  it('broadcast recordedStream — late joiner resume replays from the scope-keyed buffer', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 'b-1',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
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
        now: Date.now(),
      });
    }

    Storage.updateLastSeq(sql, {
      userId: '__bcast:top__',
      streamId: 'b-1',
      lastSeq: 3,
      now: Date.now(),
    });

    const row =
      (
        runtime as unknown as {
          sql: typeof sql;
        }
      ).sql && Storage.readStream(sql, '__bcast:top__', 'b-1');

    await resumeDurableStream(runtime as never, peer, {
      resolveDef: () => ({ scope: {}, def: baseDef({ kind: 'recorded', broadcast: true }) }),
      row,
      streamId: 'b-1',
      lastKnownSeq: 1,
    });

    const replayed = wireChunks(peer).filter((f) => f.event === 'e');
    expect(replayed.map((f) => f.__wskit.seq)).toEqual([2, 3]);
    // Active broadcast — no __streamEnd__ from the resumer (the generator is
    // still running on the creator's connection in a real run).
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeUndefined();
  });

  it('broadcast resumableStream — cursor advances on each yield, no chunks buffered (live)', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    runtime.connections.set(creator.id, creator);

    await runDurableStream(runtime as never, creator, {
      scope: {},
      def: baseDef({
        kind: 'resumable',
        broadcast: true,
        maxChunks: 10,
        generator: async function* (ctx: any) {
          for (let i = 1; i <= 3; i += 1) {
            yield ctx.stream.withCursor({ i }, { idx: i });
          }
        },
      }),
      payload: {},
      wskit: undefined,
    });

    const row = Storage.readStream(sql, '__bcast:top__', 'gen-1')!;
    expect(row).not.toBeNull();
    expect(row.broadcast).toBe(true);
    expect(
      Storage.readCursorCheckpointAtOrBefore(sql, {
        userId: '__bcast:top__',
        streamId: 'gen-1',
        seq: 99,
      }),
    ).toMatchObject({ seq: 3, cursor: JSON.stringify({ idx: 3 }) });
    expect(
      Storage.readChunksSince(sql, { userId: '__bcast:top__', streamId: 'gen-1', since: 0 }),
    ).toHaveLength(0);
  });

  it('resumableStream — cursor does not advance for a chunk produced after the connection closed', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection('c1', 'u1');

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        kind: 'resumable',
        generator: async function* (ctx: any) {
          yield ctx.stream.withCursor({ row: 1 }, { idx: 1 });
          // The owning connection drops after row 1.
          runtime.activeStreams.get('gen-1')!.closed = true;
          yield ctx.stream.withCursor({ row: 2 }, { idx: 2 });
        },
      }),
      payload: {},
      wskit: undefined,
    });

    expect(
      Storage.readCursorCheckpointAtOrBefore(sql, { userId: 'u1', streamId: 'gen-1', seq: 99 }),
    ).toMatchObject({ seq: 1, cursor: JSON.stringify({ idx: 1 }) });
  });

  it('resumableStream — a plain yield advances lastSeq without creating a checkpoint', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection('c1', 'u1');

    const seenCursors: unknown[] = [];
    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        kind: 'resumable',
        generator: async function* (ctx: any) {
          seenCursors.push(ctx.stream.cursor);
          for (let i = 1; i <= 3; i += 1) {
            yield { i };
          }
        },
      }),
      payload: {},
      wskit: undefined,
    });

    const row = Storage.readStream(sql, 'u1', 'gen-1')!;
    expect(seenCursors[0]).toBeNull();
    expect(row.lastSeq).toBe(3);
    expect(
      Storage.readCursorCheckpointAtOrBefore(sql, { userId: 'u1', streamId: 'gen-1', seq: 99 }),
    ).toBeNull();
    expect(
      Storage.readChunksSince(sql, { userId: 'u1', streamId: 'gen-1', since: 0 }),
    ).toHaveLength(0);
  });

  it('broadcast resumableStream — peer-subscriber resume goes live, no replay and no generator re-run', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-b',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
      maxChunks: 10,
    });
    Storage.updateLastSeq(sql, {
      userId: '__bcast:top__',
      streamId: 's-b',
      lastSeq: 2,
      now: Date.now(),
    });

    const row = Storage.readStream(sql, '__bcast:top__', 's-b');

    await resumeDurableStream(runtime as never, peer, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          broadcast: true,
          // oxlint-disable-next-line require-yield -- stub asserts it is never invoked
          generator: async function* () {
            throw new Error('should not be invoked for peer subscriber');
          },
        }),
      }),
      row,
      streamId: 's-b',
      lastKnownSeq: 0,
    });

    expect(wireChunks(peer).filter((f) => f.event === 'e')).toHaveLength(0);
    expect(pipelineSends.filter((p) => p.event === 'e')).toHaveLength(0);
    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeDefined();
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeUndefined();
    expect(
      Storage.getSubscriber(sql, {
        storageUserId: '__bcast:top__',
        streamId: 's-b',
        subscriberUserId: 'u-peer',
      })?.caughtUpSeq,
    ).toBe(2);
  });

  it('does not advance a peer cursor when translated resume confirmation closes the connection', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');
    runtime.sendProtocolMessage = () => {
      (peer as RuntimeConnection).closing = true;
    };

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-b',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
      maxChunks: 10,
    });
    Storage.updateLastSeq(sql, {
      userId: '__bcast:top__',
      streamId: 's-b',
      lastSeq: 5,
      now: Date.now(),
    });

    await resumeDurableStream(runtime as never, peer, {
      resolveDef: () => ({ scope: {}, def: baseDef({ kind: 'resumable', broadcast: true }) }),
      row: Storage.readStream(sql, '__bcast:top__', 's-b'),
      streamId: 's-b',
      lastKnownSeq: 0,
    });

    expect(
      Storage.getSubscriber(sql, {
        storageUserId: '__bcast:top__',
        streamId: 's-b',
        subscriberUserId: 'u-peer',
      }),
    ).toBeNull();
  });

  it('broadcast resumableStream — a late-joining peer only gets chunks produced after it joined', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    const peer = createConnection('c-peer', 'u-peer');

    runtime.connections.set(creator.id, creator);

    await runDurableStream(runtime as never, creator, {
      scope: {},
      def: baseDef({
        kind: 'resumable',
        broadcast: true,
        maxChunks: 10,
        generator: async function* (ctx: any) {
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

            yield ctx.stream.withCursor({ i }, { idx: i });
          }
        },
      }),
      payload: {},
      wskit: undefined,
    });

    const peerSeqs = pipelineSends
      .filter((p) => p.event === 'e' && p.targetId === 'c-peer')
      .map((p) => (p.routing as { seq: number }).seq);
    expect(peerSeqs).toEqual([3, 4]);
  });

  it('broadcast resumableStream — creator restarts from its confirmed checkpoint with no payload buffer', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    runtime.connections.set(creator.id, creator);

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-bc',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
      maxChunks: 10,
    });
    Storage.updateLastSeq(sql, {
      userId: '__bcast:top__',
      streamId: 's-bc',
      lastSeq: 5,
      now: Date.now(),
    });
    Storage.appendCursorCheckpoint(sql, {
      userId: '__bcast:top__',
      streamId: 's-bc',
      seq: 3,
      cursor: JSON.stringify({ idx: 3 }),
      now: Date.now(),
    });
    Storage.appendCursorCheckpoint(sql, {
      userId: '__bcast:top__',
      streamId: 's-bc',
      seq: 5,
      cursor: JSON.stringify({ idx: 5 }),
      now: Date.now(),
    });

    const row = Storage.readStream(sql, '__bcast:top__', 's-bc');

    await expect(
      resumeDurableStream(runtime as never, creator, {
        resolveDef: () => ({
          scope: {},
          def: baseDef({
            kind: 'resumable',
            broadcast: true,
            maxChunks: 10,
            generator: async function* (ctx: any) {
              const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
              yield ctx.stream.withCursor({ i: startAt + 1 }, { idx: startAt + 1 });
            },
          }),
        }),
        row,
        streamId: 's-bc',
        lastKnownSeq: 3,
      }),
    ).resolves.toBeUndefined();

    expect(protocolMessages.find((m) => m.event === '__error__')).toBeUndefined();
    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeDefined();

    expect(wireChunks(creator).filter((f) => f.event === 'e')).toHaveLength(0);

    const produced = pipelineSends
      .filter((p) => p.event === 'e')
      .map((p) => (p.routing as { seq: number }).seq);
    expect(produced).toEqual([4]);

    const buffered = Storage.readChunksSince(sql, {
      userId: '__bcast:top__',
      streamId: 's-bc',
      since: 0,
    });
    expect(buffered).toHaveLength(0);
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
      kind: 'recorded',
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
      kind: 'recorded',
      now: Date.now(),
      broadcast: true,
      creatorUserId: 'u-creator',
      maxChunks: 10,
    });

    await cancelDurableStream(runtime as never, creator, { streamId: 's-d', cancelScope: {} });

    expect(Storage.readStream(sql, '__bcast:top__', 's-d')).toBeNull();
  });

  it('broadcast resume — unsubscribed user gets stream-aborted unsubscribed', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-e',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
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
    await resumeDurableStream(runtime as never, peer, {
      resolveDef: () => ({ scope: {}, def: baseDef({ kind: 'recorded', broadcast: true }) }),
      row,
      streamId: 's-e',
      lastKnownSeq: 0,
    });

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('unsubscribed');
  });

  it('keep-running — disconnect leaves the active stream in place and marks it detached', async () => {
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
        kind: 'recorded',
        onDisconnect: 'keep-running',
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          await gate;
          yield { i: 2 };
        },
      }),
      payload: {},
      wskit: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.activeStreams.size).toBe(1);
    const live = [...runtime.activeStreams.values()][0]!;

    // Simulate the disconnect hook: keep-running entry stays put, detached
    // flag flips on, generator is NOT returned.
    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, connection.id);
    expect(runtime.activeStreams.has(live.id)).toBe(true);
    expect(live.detached).toBe(true);
    expect(live.closed).toBe(false);

    release();
    await run;
  });

  it('keep-running — finishing while detached does not send a terminal frame to the stale connection', async () => {
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
        kind: 'recorded',
        onDisconnect: 'keep-running',
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          await gate;
          yield { i: 2 };
        },
      }),
      payload: {},
      wskit: undefined,
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

  it('keep-running — resume from a fresh connection swaps the wire target and replays the buffer', async () => {
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
        kind: 'recorded',
        onDisconnect: 'keep-running',
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
          await gate;
          yield { i: 3 };
        },
      }),
      payload: {},
      wskit: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));
    const live = [...runtime.activeStreams.values()][0]!;

    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, original.id);
    expect(live.detached).toBe(true);

    const sentBeforeResume = pipelineSends.length;

    await resumeDurableStream(runtime as never, reconnect, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'recorded',
          onDisconnect: 'keep-running',
          maxChunks: 10,
          generator: async function* () {} as never,
        }),
      }),
      row: Storage.readStream(sql, 'u1', live.id),
      streamId: live.id,
      lastKnownSeq: 0,
    });

    const okFrames = protocolMessages.filter(
      (m) => m.event === '__streamOk__' && m.wskit.streamId === live.id,
    );
    expect(okFrames.length).toBeGreaterThanOrEqual(1);
    const replayed = wireChunks(reconnect).filter((f) => f.event === 'e');
    expect(replayed.map((f) => f.__wskit.seq)).toEqual([1, 2]);

    expect(live.detached).toBe(false);
    expect(live.connection?.id).toBe('c-new');
    expect(live.connectionId).toBe('c-new');

    release();
    await run;

    // The third chunk produced after resume goes through sendThroughPipeline
    // (wireTarget = live.connection = c-new), not the stale c-orig.
    const sentAfterResume = pipelineSends.length;
    expect(sentAfterResume).toBeGreaterThan(sentBeforeResume);
  });

  it('keeps a stream detached when translated replay chunks fail during creator resume', async () => {
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
        kind: 'recorded',
        onDisconnect: 'keep-running',
        generator: async function* () {
          yield { i: 1 };
          await gate;
        },
      }),
      payload: {},
      wskit: undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const live = [...runtime.activeStreams.values()][0]!;
    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, original.id);

    await resumeDurableStream(runtime as never, reconnect, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({ kind: 'recorded', onDisconnect: 'keep-running' }),
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

  it('keeps a stream detached when translated creator resume confirmation throws', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const original = createConnection('c-orig', 'u1');
    const reconnect = createConnection('c-new', 'u1');

    runtime.sendProtocolMessage = () => {
      throw new WSKitConfigError('translator outbound is invalid');
    };

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 'resume-failure',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: Date.now(),
      maxChunks: 10,
    });
    const live = {
      id: 'resume-failure',
      connection: original,
      connectionId: original.id,
      detached: true,
    } as ActiveStream;
    runtime.activeStreams.set(live.id, live);

    await expect(
      resumeDurableStream(runtime as never, reconnect, {
        resolveDef: () => ({ scope: {}, def: baseDef({ kind: 'recorded' }) }),
        row: Storage.readStream(sql, 'u1', live.id),
        streamId: live.id,
        lastKnownSeq: 0,
      }),
    ).rejects.toThrow(WSKitConfigError);

    expect(live.detached).toBe(true);
    expect(live.connection?.id).toBe(original.id);
    expect(reconnect.activeStreamIds?.has(live.id)).toBe(false);
    expect(runtime.persistAttachment).toHaveBeenLastCalledWith(reconnect, { force: true });
  });

  it('keep-running — after resume, final __streamEnd__ targets the fresh connection and clears its attachment', async () => {
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
        kind: 'recorded',
        onDisconnect: 'keep-running',
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          await gate;
          yield { i: 2 };
        },
      }),
      payload: {},
      wskit: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));
    const live = [...runtime.activeStreams.values()][0]!;
    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, original.id);
    original.closing = true;

    await resumeDurableStream(runtime as never, reconnect, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'recorded',
          onDisconnect: 'keep-running',
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
      (message) => message.event === '__streamEnd__' && message.wskit.streamId === live.id,
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
        kind: 'recorded',
        generator: (() => {
          throw new Error('generator factory blew up');
        }) as never,
      }),
      payload: {},
      wskit: undefined,
    });

    expect(Storage.readStream(sql, 'u1', 'gen-1')?.status).toBe('ended');
    expect(runtime.activeStreams.has('gen-1')).toBe(false);
    expect(connection.activeStreamIds?.has('gen-1')).toBeFalsy();
  });

  it('WSKitConfigError during iteration marks the row ended then rethrows', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    await expect(
      runDurableStream(runtime as never, connection, {
        scope: {},
        def: baseDef({
          kind: 'recorded',
          generator: async function* () {
            yield { i: 1 };
            throw new WSKitConfigError('bad stream config');
          },
        }),
        payload: {},
        wskit: undefined,
      }),
    ).rejects.toBeInstanceOf(WSKitConfigError);

    expect(Storage.readStream(sql, 'u1', 'gen-1')?.status).toBe('ended');
    expect(runtime.activeStreams.has('gen-1')).toBe(false);
  });

  it('stale-generator cleanup on resume reports a rejected return() instead of leaking it', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 'a',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });

    let returnCalled!: () => void;
    const returned = new Promise<void>((resolve) => {
      returnCalled = resolve;
    });
    const stale = {
      streamId: 'a',
      connection,
      closed: false,
      detached: false,
      generator: {
        return: () => {
          returnCalled();
          return Promise.reject(new Error('return blew up'));
        },
        next: () => Promise.resolve({ done: true, value: undefined }),
        throw: () => Promise.resolve({ done: true, value: undefined }),
      },
    } as unknown as ActiveStream;
    runtime.activeStreams.set('a', stale);

    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* () {},
        }),
      }),
      row: Storage.readStream(sql, 'u1', 'a'),
      streamId: 'a',
      lastKnownSeq: 0,
    });

    await returned;
    await Promise.resolve();
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      '[wskit] durable stream stale-generator cleanup rejected',
      expect.objectContaining({ streamId: 'a', error: 'return blew up' }),
    );
  });

  it('stale-generator cleanup tolerates a synchronous return() throw on resume (#5)', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      userId: 'u1',
      streamId: 'a',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });

    const stale = {
      streamId: 'a',
      connection,
      closed: false,
      detached: false,
      generator: {
        return: () => {
          throw new Error('sync return boom');
        },
        next: () => Promise.resolve({ done: true, value: undefined }),
        throw: () => Promise.resolve({ done: true, value: undefined }),
      },
    } as unknown as ActiveStream;
    runtime.activeStreams.set('a', stale);

    // The synchronous throw must not abort the resume — it resolves normally.
    await resumeDurableStream(runtime as never, connection, {
      resolveDef: () => ({
        scope: {},
        def: baseDef({ kind: 'resumable', generator: async function* () {} }),
      }),
      row: Storage.readStream(sql, 'u1', 'a'),
      streamId: 'a',
      lastKnownSeq: 0,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      '[wskit] durable stream stale-generator cleanup rejected',
      expect.objectContaining({ streamId: 'a', error: 'sync return boom' }),
    );
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
        kind: 'recorded',
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
      wskit: { streamId: 's-sig', channelFamily: null },
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
        kind: 'recorded',
        maxChunks: 10,
        generator: wrapStreamGenerator(async function* (c: any) {
          yield { i: 1 };
          await c.stream.drain();
          drainResolved = true;
          yield { i: 2 };
        }) as never,
      }),
      payload: {},
      wskit: { streamId: 's-drain', channelFamily: null },
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
        kind: 'recorded',
        broadcast: true,
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
        },
      }),
      payload: {},
      wskit: undefined,
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

  it('runDurableStream still refuses an anonymous creator (unaffected by the storage-key rename)', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const anon = createConnection('c-anon', '');

    await expect(
      runDurableStream(runtime as never, anon, {
        scope: {},
        def: baseDef({ kind: 'recorded' }),
        payload: {},
        wskit: undefined,
      }),
    ).rejects.toThrow();
  });

  it('an identified connection resuming after a reconnect (new connection id, same user id) still finds its own row', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime: creatorRuntime } = createRuntime(sql);
    const original = createConnection('c-original', 'u-alice');
    creatorRuntime.connections.set(original.id, original);

    await runDurableStream(creatorRuntime as never, original, {
      scope: {},
      def: baseDef({
        kind: 'recorded',
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
        },
      }),
      payload: {},
      wskit: { streamId: 'reconnect-1', channelFamily: null },
    });

    const { runtime: resumeRuntime, protocolMessages } = createRuntime(sql);
    const reconnected = createConnection('c-reconnected', 'u-alice');
    resumeRuntime.connections.set(reconnected.id, reconnected);

    const row = Storage.readStream(sql, 'u-alice', 'reconnect-1');
    await resumeDurableStream(resumeRuntime as never, reconnected, {
      resolveDef: () => ({ scope: {}, def: baseDef({ kind: 'recorded' }) }),
      row,
      streamId: 'reconnect-1',
      lastKnownSeq: 0,
    });

    expect(protocolMessages.find((m) => m.event === '__error__')).toBeUndefined();
  });
});
