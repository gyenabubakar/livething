/* oxlint-disable @typescript-eslint/no-explicit-any */
import { StreamAborted } from '@wskit/core';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveStream, RuntimeConnection } from '~/_engine/runtime/types.ts';
import { cancelDurableStream, resumeDurableStream, runDurableStream } from './runtime.ts';
import * as Storage from './storage.ts';
import type { DurableStreamRuntimeDef } from './runtime.ts';

// ---------- in-memory SQL stub (shared across tests) ----------
function makeSql() {
  const streams = new Map<string, Record<string, unknown>>();
  const chunks = new Map<string, Record<string, unknown>>();
  function key(parts: unknown[]): string {
    return parts.join('|');
  }

  return {
    streams,
    chunks,
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
  const protocolMessages: { event: string; payload: Record<string, unknown> }[] = [];
  const pipelineSends: { event: string; payload: unknown; routing: unknown }[] = [];
  let nextStreamId = 0;

  const runtime = {
    sql: sqlInstance,
    activeStreams: new Map<string, ActiveStream>(),
    generateId: () => `gen-${++nextStreamId}`,
    buildConnectionContext: () => ({ id: 'ctx', nudges: () => [] }),
    sendProtocolMessage: (
      _conn: RuntimeConnection,
      event: string,
      payload: Record<string, unknown>,
    ) => {
      protocolMessages.push({ event, payload });
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
    setActiveConnectionId: vi.fn(),
    persistAttachment: vi.fn(),
    logger: { warn: vi.fn() },
    errorHooks: [] as readonly ((
      ctx: unknown,
      error: unknown,
      event?: string,
    ) => void | Promise<void>)[],
    handleRuntimeError: vi.fn(async () => {}),
  };

  return { runtime, protocolMessages, pipelineSends };
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
  it('recorded stream — completes cleanly, marks the row ended, sends _streamEnd', async () => {
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

    expect(protocolMessages.find((m) => m.event === '_streamOk')).toBeDefined();
    const end = protocolMessages.find((m) => m.event === '_streamEnd');
    expect(end?.payload._seq).toBe(2);

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
    // The dev caught the error and returned cleanly — _streamEnd fires.
    expect(protocolMessages.find((m) => m.event === '_streamEnd')).toBeDefined();
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

    await cancelDurableStream(runtime as never, connection, 's-1');

    expect(Storage.readStream(sql, 'u1', 's-1')).toBeNull();
    expect(Storage.readChunksSince(sql, 'u1', 's-1', 0)).toEqual([]);
  });

  it('resumeDurableStream — unknown stream id surfaces stream-aborted not-found', async () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const { runtime, protocolMessages } = createRuntime(sql);
    const connection = createConnection();

    await resumeDurableStream(runtime as never, connection, () => undefined, 'missing', 0);

    const err = protocolMessages.find((m) => m.event === '_error');
    expect(err?.payload.code).toBe('stream-aborted');
    expect((err?.payload.detail as { reason: string } | undefined)?.reason).toBe('not-found');
    expect(err?.payload._streamId).toBe('missing');
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
      'busy',
      0,
    );

    // The stale entry was asked to close; resume continued with a fresh
    // generator run. No _error frame, and a _streamOk was sent for the
    // re-invocation.
    expect(protocolMessages.find((m) => m.event === '_error')).toBeUndefined();
    expect(protocolMessages.find((m) => m.event === '_streamOk')).toBeDefined();
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
      's-replay',
      2,
    );

    const replayed = protocolMessages.filter((m) => m.event === 'e');
    expect(replayed.map((m) => m.payload._seq)).toEqual([3, 4, 5]);
    expect(protocolMessages.find((m) => m.event === '_streamEnd')).toBeDefined();
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
      's-cursor',
      4,
    );

    const sent = pipelineSends.filter((m) => m.event === 'e').map((m) => m.payload);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ i: 5 });
    expect(sent[1]).toMatchObject({ i: 6 });
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
});
