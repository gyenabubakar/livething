/* oxlint-disable @typescript-eslint/no-explicit-any */
import { StreamAborted } from '@wskit/core';
import * as ConnectionLifecycle from '~/_engine/runtime/connection.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveStream, RuntimeConnection } from '~/_engine/runtime/types.ts';
import { cancelDurableStream, resumeDurableStream, runDurableStream } from './runtime.ts';
import * as Storage from './storage.ts';
import type { DurableStreamRuntimeDef } from './runtime.ts';

// ---------- in-memory SQL stub (shared across tests) ----------
function makeSql() {
  const streams = new Map<string, Record<string, unknown>>();
  const chunks = new Map<string, Record<string, unknown>>();
  const subscribers = new Map<string, { caught_up_seq: unknown; unsubscribed_at: unknown }>();
  function key(parts: unknown[]): string {
    return parts.join('|');
  }

  return {
    streams,
    chunks,
    subscribers,
    exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] } {
      const q = query.trim();
      if (q.startsWith('PRAGMA') || q.startsWith('CREATE')) return { toArray: () => [] };

      if (q.startsWith('INSERT INTO _wskit_streams')) {
        const [
          identity,
          streamId,
          event,
          payload,
          kind,
          namespace,
          channelKey,
          channelScope,
          broadcast,
          creatorIdentity,
          startedAt,
          lastActivityAt,
          maxChunks,
          maxAgeMs,
          retentionAfterEndMs,
        ] = params;
        streams.set(key([identity, streamId]), {
          identity,
          stream_id: streamId,
          event,
          payload,
          kind,
          status: 'active',
          cursor: null,
          last_seq: 0,
          namespace,
          channel_key: channelKey,
          channel_scope: channelScope,
          broadcast,
          creator_identity: creatorIdentity,
          started_at: startedAt,
          last_activity_at: lastActivityAt,
          ended_at: null,
          max_chunks: maxChunks,
          max_age_ms: maxAgeMs,
          retention_after_end_ms: retentionAfterEndMs,
        });
        return { toArray: () => [] };
      }
      if (q.startsWith('SELECT * FROM _wskit_streams WHERE identity')) {
        const [identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        return { toArray: () => (row ? [row] : []) };
      }
      if (q.startsWith('UPDATE _wskit_streams SET cursor')) {
        const [cursor, lastSeq, now, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row) {
          row.cursor = cursor;
          row.last_seq = lastSeq;
          row.last_activity_at = now;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith('UPDATE _wskit_streams SET last_seq')) {
        const [lastSeq, now, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row) {
          row.last_seq = lastSeq;
          row.last_activity_at = now;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith("UPDATE _wskit_streams SET status = 'suspended'")) {
        const [now, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row && row.status === 'active') {
          row.status = 'suspended';
          row.last_activity_at = now;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith("UPDATE _wskit_streams SET status = 'ended'")) {
        const [now, lastActivityAt, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row) {
          row.status = 'ended';
          row.ended_at = now;
          row.last_activity_at = lastActivityAt;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith("UPDATE _wskit_streams SET status = 'active'")) {
        const [now, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row) {
          row.status = 'active';
          row.last_activity_at = now;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith('DELETE FROM _wskit_streams')) {
        const [identity, streamId] = params;
        streams.delete(key([identity, streamId]));
        for (const k of [...chunks.keys()]) {
          if (k.startsWith(key([identity, streamId]) + '|')) chunks.delete(k);
        }
        return { toArray: () => [] };
      }
      if (q.startsWith('INSERT INTO _wskit_stream_chunks')) {
        const [identity, streamId, seq, messageId, payload, now] = params;
        chunks.set(key([identity, streamId, seq]), {
          identity,
          stream_id: streamId,
          seq,
          message_id: messageId,
          payload,
          emitted_at: now,
        });
        return { toArray: () => [] };
      }
      if (q.startsWith('SELECT * FROM _wskit_stream_chunks')) {
        const [identity, streamId, since] = params;
        const out: Record<string, unknown>[] = [];
        for (const row of chunks.values()) {
          if (
            row.identity === identity &&
            row.stream_id === streamId &&
            Number(row.seq) > Number(since)
          ) {
            out.push(row);
          }
        }
        out.sort((a, b) => Number(a.seq) - Number(b.seq));
        return { toArray: () => out };
      }
      if (q.startsWith('SELECT COUNT(*) AS n FROM _wskit_stream_chunks')) {
        const [identity, streamId] = params;
        let n = 0;
        for (const row of chunks.values()) {
          if (row.identity === identity && row.stream_id === streamId) n += 1;
        }
        return { toArray: () => [{ n }] };
      }
      if (q.startsWith('INSERT OR IGNORE INTO _wskit_stream_subscribers')) {
        const [identity, streamId, subscriberIdentity] = params;
        const k = key([identity, streamId, subscriberIdentity]);
        if (!subscribers.has(k)) subscribers.set(k, { caught_up_seq: 0, unsubscribed_at: null });
        return { toArray: () => [] };
      }
      if (q.startsWith('INSERT INTO _wskit_stream_subscribers')) {
        const [identity, streamId, subscriberIdentity, value] = params;
        const k = key([identity, streamId, subscriberIdentity]);
        const row = subscribers.get(k) ?? { caught_up_seq: 0, unsubscribed_at: null };
        if (q.includes('DO UPDATE SET caught_up_seq')) row.caught_up_seq = value;
        else row.unsubscribed_at = value;
        subscribers.set(k, row);
        return { toArray: () => [] };
      }
      if (q.startsWith('SELECT caught_up_seq, unsubscribed_at FROM _wskit_stream_subscribers')) {
        const [identity, streamId, subscriberIdentity] = params;
        const row = subscribers.get(key([identity, streamId, subscriberIdentity]));
        return { toArray: () => (row ? [{ ...row }] : []) };
      }
      if (q.startsWith('DELETE FROM _wskit_stream_chunks')) {
        // The trimOldestChunks query uses a sub-select. For the stub, mimic
        // the result: delete the oldest entries beyond `keepNewest`.
        const lastIndex = params.length - 1;
        const keepNewest = Number(params[lastIndex]);
        const [identity, streamId] = params;
        const matches: Record<string, unknown>[] = [];
        for (const row of chunks.values()) {
          if (row.identity === identity && row.stream_id === streamId) matches.push(row);
        }
        matches.sort((a, b) => Number(a.seq) - Number(b.seq));
        const dropCount = Math.max(0, matches.length - keepNewest);
        for (let i = 0; i < dropCount; i += 1) {
          chunks.delete(key([matches[i]!.identity, matches[i]!.stream_id, matches[i]!.seq]));
        }
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    },
  };
}

// ---------- runtime + connection scaffolding ----------
function createConnection(id = 'c1', identity = 'u1'): RuntimeConnection {
  return {
    id,
    identity,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity,
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createRuntime(sqlInstance: ReturnType<typeof makeSql>) {
  const protocolMessages: {
    event: string;
    payload: Record<string, unknown>;
    wskit: Record<string, unknown>;
  }[] = [];
  const pipelineSends: { event: string; payload: unknown; routing: unknown }[] = [];
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
      _conn: RuntimeConnection,
      event: string,
      payload: Record<string, unknown>,
      wskit: Record<string, unknown>,
    ) => {
      protocolMessages.push({ event, payload, wskit });
    },
    sendThroughPipeline: (
      _conn: RuntimeConnection,
      routing: unknown,
      event: string,
      payload: unknown,
    ) => {
      pipelineSends.push({ event, payload, routing });
      return true;
    },
    broadcastToConnections: (
      targets: readonly RuntimeConnection[],
      event: string,
      payload: unknown,
    ) => {
      broadcasts.push({ targets, event, payload });
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

// ---------- tests ----------
describe('durable stream runtime', () => {
  it('recorded stream — completes cleanly, marks the row ended, sends __streamEnd__', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    await runDurableStream(
      runtime as never,
      connection,
      {},
      baseDef({
        kind: 'recorded',
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
        },
      }),
      {},
      undefined,
    );

    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeDefined();
    const end = protocolMessages.find((m) => m.event === '__streamEnd__');
    expect(end?.wskit.seq).toBe(2);

    const row = Storage.readStream(sql, 'u1', 'gen-1');
    expect(row?.status).toBe('ended');
    expect(Storage.readChunksSince(sql, 'u1', 'gen-1', 0)).toHaveLength(2);
  });

  it('recorded stream — yield throws StreamAborted({reason:"buffer-full"}) when cap is hit', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    let caughtReason: string | null = null;
    await runDurableStream(
      runtime as never,
      connection,
      {},
      baseDef({
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
      {},
      undefined,
    );

    expect(caughtReason).toBe('buffer-full');
    // The buffer holds at most `maxChunks` chunks after trim.
    const chunkRows = Storage.readChunksSince(sql, 'u1', 'gen-1', 0);
    expect(chunkRows.length).toBeLessThanOrEqual(2);
    // The dev caught the error and returned cleanly — __streamEnd__ fires.
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeDefined();
  });

  it('cancelDurableStream — deletes row + chunks immediately', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: Date.now(),
      maxChunks: 10,
    });
    Storage.appendChunk(sql, {
      identity: 'u1',
      streamId: 's-1',
      seq: 1,
      messageId: null,
      payload: '{}',
      now: Date.now(),
    });

    await cancelDurableStream(runtime as never, connection, 's-1', {});

    expect(Storage.readStream(sql, 'u1', 's-1')).toBeNull();
    expect(Storage.readChunksSince(sql, 'u1', 's-1', 0)).toEqual([]);
  });

  it('resumeDurableStream — unknown stream id surfaces stream-aborted not-found', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    await resumeDurableStream(runtime as never, connection, () => undefined, null, 'missing', 0);

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(err?.wskit.streamId).toBe('missing');
  });

  it('resumeDurableStream — closes any in-flight generator for the same id and proceeds', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      identity: 'u1',
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

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* (ctx: any) {
            yield ctx.stream.withCursor({ idx: 1 }, { idx: 1 });
          },
        }),
      }),
      Storage.readStream(sql, 'u1', 'busy'),
      'busy',
      0,
    );

    // The stale entry was asked to close; resume continued with a fresh
    // generator run. No __error__ frame, and a __streamOk__ was sent for the
    // re-invocation.
    expect(protocolMessages.find((m) => m.event === '__error__')).toBeUndefined();
    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeDefined();
    expect(returnSpy).toHaveBeenCalled();
  });

  it('resumeDurableStream — recorded stream replays missed chunks since `since` then _streamEnd', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    // Seed an ended recorded stream with chunks 1..5.
    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 's-replay',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: Date.now(),
      maxChunks: 10,
    });
    for (let seq = 1; seq <= 5; seq += 1) {
      Storage.appendChunk(sql, {
        identity: 'u1',
        streamId: 's-replay',
        seq,
        messageId: `m-${seq}`,
        payload: JSON.stringify({ i: seq }),
        now: Date.now(),
      });
    }
    Storage.markEnded(sql, 'u1', 's-replay', Date.now());

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({ scope: {}, def: baseDef({ kind: 'recorded' }) }),
      Storage.readStream(sql, 'u1', 's-replay'),
      's-replay',
      2,
    );

    const replayed = protocolMessages.filter((m) => m.event === 'e');
    expect(replayed.map((m) => m.wskit.seq)).toEqual([3, 4, 5]);
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeDefined();
  });

  it('resumeDurableStream — resumable stream re-invokes the generator with the saved cursor', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 's-cursor',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    // Stamp cursor as if a prior run made it to idx=4.
    Storage.updateCursor(sql, 'u1', 's-cursor', JSON.stringify({ idx: 4 }), 4, Date.now());
    Storage.markSuspended(sql, 'u1', 's-cursor', Date.now());

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({
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
      Storage.readStream(sql, 'u1', 's-cursor'),
      's-cursor',
      4,
    );

    const sent = pipelineSends.filter((m) => m.event === 'e').map((m) => m.payload);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ i: 5 });
    expect(sent[1]).toMatchObject({ i: 6 });
  });

  it('resumeDurableStream — resumed run continues seq from row.lastSeq, not from 1', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 's-seq',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    Storage.updateCursor(sql, 'u1', 's-seq', JSON.stringify({ idx: 3 }), 3, Date.now());
    Storage.markSuspended(sql, 'u1', 's-seq', Date.now());

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({
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
      Storage.readStream(sql, 'u1', 's-seq'),
      's-seq',
      3,
    );

    const seqs = pipelineSends
      .filter((m) => m.event === 'e')
      .map((m) => (m.routing as { seq: number }).seq);
    expect(seqs).toEqual([4, 5]);
  });

  it('resumeDurableStream — suspended row past maxAgeMs surfaces stream-aborted expired and deletes the row', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    const longAgo = Date.now() - 60_000;
    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 's-old',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: longAgo,
      maxAgeMs: 1_000,
    });
    Storage.markSuspended(sql, 'u1', 's-old', longAgo);

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({ scope: {}, def: baseDef({ kind: 'resumable' }) }),
      Storage.readStream(sql, 'u1', 's-old'),
      's-old',
      0,
    );

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('expired');
    expect(Storage.readStream(sql, 'u1', 's-old')).toBeNull();
  });

  it('resumeDurableStream — ended row past retentionAfterEndMs surfaces stream-aborted not-found and deletes the row', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    const longAgo = Date.now() - 60_000;
    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 's-ended-old',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: longAgo,
      retentionAfterEndMs: 500,
    });
    Storage.markEnded(sql, 'u1', 's-ended-old', longAgo);

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({ scope: {}, def: baseDef({ kind: 'recorded' }) }),
      Storage.readStream(sql, 'u1', 's-ended-old'),
      's-ended-old',
      0,
    );

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(Storage.readStream(sql, 'u1', 's-ended-old')).toBeNull();
  });

  it('resumeDurableStream — saved cursor passes the def.cursor validator and reaches the generator', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 's-valid',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    Storage.updateCursor(sql, 'u1', 's-valid', JSON.stringify({ idx: 7 }), 7, Date.now());
    Storage.markSuspended(sql, 'u1', 's-valid', Date.now());

    function cursorValidator(raw: unknown): { idx: number } {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.idx !== 'number') throw new Error('idx must be a number');
      return { idx: obj.idx };
    }

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({
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
      Storage.readStream(sql, 'u1', 's-valid'),
      's-valid',
      7,
    );

    const sent = pipelineSends.filter((m) => m.event === 'e').map((m) => m.payload);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ i: 8 });
  });

  it('resumeDurableStream — cursor that fails the validator surfaces stream-aborted cursor-invalid', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 's-bad',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    // Stamp a cursor shape the validator will reject (idx is a string).
    Storage.updateCursor(sql, 'u1', 's-bad', JSON.stringify({ idx: 'oops' }), 4, Date.now());
    Storage.markSuspended(sql, 'u1', 's-bad', Date.now());

    // Schema rejects the stored cursor because `idx` is a string.
    const cursorValidator = v.object({ idx: v.number() });

    const generatorSpy = vi.fn(async function* () {
      yield { i: 1 };
    });

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          cursor: cursorValidator,
          generator: generatorSpy as never,
        }),
      }),
      Storage.readStream(sql, 'u1', 's-bad'),
      's-bad',
      4,
    );

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('cursor-invalid');
    expect(err?.wskit.streamId).toBe('s-bad');
    // Generator never ran, no chunks went out, no __streamOk__ frame either.
    expect(generatorSpy).not.toHaveBeenCalled();
    expect(pipelineSends).toHaveLength(0);
    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeUndefined();
  });

  it('ctx.stream.attempt — is 1 on first run', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    await runDurableStream(
      runtime as never,
      connection,
      {},
      baseDef({
        kind: 'resumable',
        generator: async function* (ctx: any) {
          yield ctx.stream.withCursor({ attempt: ctx.stream.attempt }, { idx: 1 });
        },
      }),
      {},
      undefined,
    );

    expect((pipelineSends[0]!.payload as { attempt: number }).attempt).toBe(1);
  });

  it('ctx.stream.attempt — is 2 on resume', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends } = createRuntime(sql);
    const connection = createConnection();

    Storage.insertStream(sql, {
      identity: 'u1',
      streamId: 'a',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
    });
    Storage.markSuspended(sql, 'u1', 'a', Date.now());

    await resumeDurableStream(
      runtime as never,
      connection,
      () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          generator: async function* (ctx: any) {
            yield ctx.stream.withCursor({ attempt: ctx.stream.attempt }, { idx: 1 });
          },
        }),
      }),
      Storage.readStream(sql, 'u1', 'a'),
      'a',
      0,
    );

    expect((pipelineSends[0]!.payload as { attempt: number }).attempt).toBe(2);
  });

  it('nudges — populates nudgeValidators on the active stream', async () => {
    const sql = makeSql();
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

    const run = runDurableStream(
      runtime as never,
      connection,
      {},
      baseDef({
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
      {},
      undefined,
    );

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
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    function noop(): void {}
    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen: { event: string; payload: unknown }[] = [];

    const run = runDurableStream(
      runtime as never,
      connection,
      {},
      baseDef({
        kind: 'recorded',
        nudges: [{ event: 'pause', validator: undefined }],
        generator: async function* (ctx: any) {
          yield { i: 1 };
          await gate;
          const value = yield { i: 2 };
          seen = ctx.nudges(value);
        },
      }),
      {},
      undefined,
    );

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
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, pipelineSends, protocolMessages } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    const peer = createConnection('c-peer', 'u-peer');
    runtime.connections.set(creator.id, creator);
    runtime.connections.set(peer.id, peer);

    await runDurableStream(
      runtime as never,
      creator,
      {},
      baseDef({
        kind: 'recorded',
        broadcast: true,
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          yield { i: 2 };
        },
      }),
      {},
      undefined,
    );

    // Row is keyed by broadcast scope key (top-level here), not the
    // creator's identity.
    expect(Storage.readStream(sql, 'u-creator', 'gen-1')).toBeNull();
    const row = Storage.readStream(sql, '__bcast:top__', 'gen-1');
    expect(row).not.toBeNull();
    expect(row!.broadcast).toBe(true);
    expect(row!.creatorIdentity).toBe('u-creator');

    // Both chunks were sent to the peer via the outgoing pipeline (same as
    // the creator's own copies — broadcastToConnections is no longer used
    // for the chunk fan-out because reserved-field markers must ride the
    // routing arg, not the payload). One pipeline send per chunk per
    // recipient: 2 chunks × 2 recipients = 4 sends.
    expect(pipelineSends.filter((p) => p.event === 'e')).toHaveLength(4);
    // The closing __streamEnd__ is sent via sendProtocolMessage to each peer.
    expect(protocolMessages.filter((m) => m.event === '__streamEnd__')).toHaveLength(2);
  });

  it('broadcast recordedStream — late joiner resume replays from the scope-keyed buffer', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    // Seed a broadcast row + chunks under the scope key.
    Storage.insertStream(sql, {
      identity: '__bcast:top__',
      streamId: 'b-1',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: Date.now(),
      broadcast: true,
      creatorIdentity: 'u-creator',
      maxChunks: 10,
    });
    for (let seq = 1; seq <= 3; seq += 1) {
      Storage.appendChunk(sql, {
        identity: '__bcast:top__',
        streamId: 'b-1',
        seq,
        messageId: null,
        payload: JSON.stringify({ i: seq }),
        now: Date.now(),
      });
    }
    Storage.updateLastSeq(sql, '__bcast:top__', 'b-1', 3, Date.now());

    const row =
      (
        runtime as unknown as {
          sql: typeof sql;
        }
      ).sql && Storage.readStream(sql, '__bcast:top__', 'b-1');

    await resumeDurableStream(
      runtime as never,
      peer,
      () => ({ scope: {}, def: baseDef({ kind: 'recorded', broadcast: true }) }),
      row,
      'b-1',
      1,
    );

    const replayed = protocolMessages.filter((m) => m.event === 'e');
    expect(replayed.map((m) => m.wskit.seq)).toEqual([2, 3]);
    // Active broadcast — no __streamEnd__ from the resumer (the generator is
    // still running on the creator's connection in a real run).
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeUndefined();
  });

  it('broadcast resumableStream — chunks land in buffer + cursor advances on each yield', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');
    runtime.connections.set(creator.id, creator);

    await runDurableStream(
      runtime as never,
      creator,
      {},
      baseDef({
        kind: 'resumable',
        broadcast: true,
        maxChunks: 10,
        generator: async function* (ctx: any) {
          for (let i = 1; i <= 3; i += 1) {
            yield ctx.stream.withCursor({ i }, { idx: i });
          }
        },
      }),
      {},
      undefined,
    );

    // Row exists under broadcast scope key.
    const row = Storage.readStream(sql, '__bcast:top__', 'gen-1')!;
    expect(row).not.toBeNull();
    expect(row.broadcast).toBe(true);
    expect(JSON.parse(row.cursor!)).toEqual({ idx: 3 });
    // Chunks recorded under the same scope key for late-joiner catch-up.
    expect(Storage.readChunksSince(sql, '__bcast:top__', 'gen-1', 0)).toHaveLength(3);
  });

  it('resumableStream — cursor does not advance for a chunk produced after the connection closed', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection('c1', 'u1');

    await runDurableStream(
      runtime as never,
      connection,
      {},
      baseDef({
        kind: 'resumable',
        generator: async function* (ctx: any) {
          yield ctx.stream.withCursor({ row: 1 }, { idx: 1 });
          // The owning connection drops after row 1.
          runtime.activeStreams.get('gen-1')!.closed = true;
          yield ctx.stream.withCursor({ row: 2 }, { idx: 2 });
        },
      }),
      {},
      undefined,
    );

    // The cursor must still point at row 1 — a resume re-runs from there, so
    // moving it to row 2 (which the closed client never got) would skip a row.
    expect(JSON.parse(Storage.readStream(sql, 'u1', 'gen-1')!.cursor!)).toEqual({ idx: 1 });
  });

  it('broadcast resumableStream — peer-subscriber resume replays from buffer, no generator re-run', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      identity: '__bcast:top__',
      streamId: 's-b',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
      broadcast: true,
      creatorIdentity: 'u-creator',
      maxChunks: 10,
    });
    Storage.appendChunk(sql, {
      identity: '__bcast:top__',
      streamId: 's-b',
      seq: 1,
      messageId: null,
      payload: JSON.stringify({ i: 1 }),
      now: Date.now(),
    });
    Storage.appendChunk(sql, {
      identity: '__bcast:top__',
      streamId: 's-b',
      seq: 2,
      messageId: null,
      payload: JSON.stringify({ i: 2 }),
      now: Date.now(),
    });

    const row = Storage.readStream(sql, '__bcast:top__', 's-b');

    await resumeDurableStream(
      runtime as never,
      peer,
      () => ({
        scope: {},
        def: baseDef({
          kind: 'resumable',
          broadcast: true,
          generator: async function* () {
            yield { unreachable: true };
            throw new Error('should not be invoked for peer subscriber');
          },
        }),
      }),
      row,
      's-b',
      0,
    );

    const replayed = protocolMessages.filter((m) => m.event === 'e');
    expect(replayed.map((m) => m.wskit.seq)).toEqual([1, 2]);
    // Peer never reaches the generator — no pipeline sends, no __streamEnd__.
    expect(pipelineSends.filter((p) => p.event === 'e')).toHaveLength(0);
    expect(protocolMessages.find((m) => m.event === '__streamEnd__')).toBeUndefined();
  });

  it('broadcast cancel — non-creator unsubscribes self, source keeps running', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      identity: '__bcast:top__',
      streamId: 's-c',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: Date.now(),
      broadcast: true,
      creatorIdentity: 'u-creator',
      maxChunks: 10,
    });

    await cancelDurableStream(runtime as never, peer, 's-c', {});

    // Row is still there; peer is on the unsubscribed list.
    expect(Storage.readStream(sql, '__bcast:top__', 's-c')).not.toBeNull();
    expect(Storage.isUnsubscribed(sql, '__bcast:top__', 's-c', 'u-peer')).toBe(true);
  });

  it('broadcast cancel — creator kills the source for everyone', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const creator = createConnection('c-creator', 'u-creator');

    Storage.insertStream(sql, {
      identity: '__bcast:top__',
      streamId: 's-d',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: Date.now(),
      broadcast: true,
      creatorIdentity: 'u-creator',
      maxChunks: 10,
    });

    await cancelDurableStream(runtime as never, creator, 's-d', {});

    expect(Storage.readStream(sql, '__bcast:top__', 's-d')).toBeNull();
  });

  it('broadcast resume — unsubscribed identity gets stream-aborted unsubscribed', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const peer = createConnection('c-peer', 'u-peer');

    Storage.insertStream(sql, {
      identity: '__bcast:top__',
      streamId: 's-e',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: Date.now(),
      broadcast: true,
      creatorIdentity: 'u-creator',
      maxChunks: 10,
    });
    Storage.markUnsubscribed(sql, '__bcast:top__', 's-e', 'u-peer', Date.now());

    const row = Storage.readStream(sql, '__bcast:top__', 's-e');
    await resumeDurableStream(
      runtime as never,
      peer,
      () => ({ scope: {}, def: baseDef({ kind: 'recorded', broadcast: true }) }),
      row,
      's-e',
      0,
    );

    const err = protocolMessages.find((m) => m.event === '__error__');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('unsubscribed');
  });

  it('keep-running — disconnect leaves the active stream in place and marks it detached', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime } = createRuntime(sql);
    const connection = createConnection();

    function noopRelease(): void {}
    let release: () => void = noopRelease;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runDurableStream(
      runtime as never,
      connection,
      {},
      baseDef({
        kind: 'recorded',
        onDisconnect: 'keep-running',
        maxChunks: 10,
        generator: async function* () {
          yield { i: 1 };
          await gate;
          yield { i: 2 };
        },
      }),
      {},
      undefined,
    );

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

  it('keep-running — resume from a fresh connection swaps the wire target and replays the buffer', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages, pipelineSends } = createRuntime(sql);
    const original = createConnection('c-orig', 'u1');
    const reconnect = createConnection('c-new', 'u1');

    function noopRelease(): void {}
    let release: () => void = noopRelease;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runDurableStream(
      runtime as never,
      original,
      {},
      baseDef({
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
      {},
      undefined,
    );

    await new Promise((r) => setTimeout(r, 10));
    const live = [...runtime.activeStreams.values()][0]!;

    await ConnectionLifecycle.cancelActiveStreamsForConnection(runtime as never, original.id);
    expect(live.detached).toBe(true);

    const sentBeforeResume = pipelineSends.length;

    await resumeDurableStream(
      runtime as never,
      reconnect,
      () => ({
        scope: {},
        def: baseDef({
          kind: 'recorded',
          onDisconnect: 'keep-running',
          maxChunks: 10,
          generator: async function* () {} as never,
        }),
      }),
      Storage.readStream(sql, 'u1', live.id),
      live.id,
      0,
    );

    // Adopt sent __streamOk__ + replayed both buffered chunks to the new wire.
    const okFrames = protocolMessages.filter(
      (m) => m.event === '__streamOk__' && m.wskit.streamId === live.id,
    );
    expect(okFrames.length).toBeGreaterThanOrEqual(1);
    const replayed = protocolMessages.filter((m) => m.event === 'e');
    expect(replayed.map((m) => m.wskit.seq)).toEqual([1, 2]);

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
});
