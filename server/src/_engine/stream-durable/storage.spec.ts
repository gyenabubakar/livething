/* oxlint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Storage from './storage.ts';

// In-memory SQL stub that satisfies the storage helpers. Just enough to
// exercise the CRUD paths; not a faithful sqlite implementation.
function memorySql() {
  const streams = new Map<string, Record<string, unknown>>();
  const chunks = new Map<string, Record<string, unknown>>();
  const unsubscribed = new Set<string>();
  let raiseConstraint = false;
  function key(parts: unknown[]): string {
    return parts.join('|');
  }

  function setConstraintMode(on: boolean): void {
    raiseConstraint = on;
  }

  return {
    streams,
    chunks,
    setConstraintMode,
    exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] } {
      const q = query.trim();
      if (q.startsWith('PRAGMA') || q.startsWith('CREATE')) return { toArray: () => [] };

      if (q.startsWith('INSERT INTO _wskit_streams')) {
        if (raiseConstraint) {
          throw new Error(
            'UNIQUE constraint failed: _wskit_streams.identity, _wskit_streams.stream_id',
          );
        }
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
        // emulate ON DELETE CASCADE
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

      if (q.startsWith('SELECT identity, stream_id FROM _wskit_streams')) {
        const isSuspended = q.includes("status = 'suspended'");
        const [now] = params;
        const out: Record<string, unknown>[] = [];
        for (const row of streams.values()) {
          if (isSuspended) {
            if (row.status !== 'suspended') continue;
            if (row.max_age_ms == null) continue;
            if (Number(row.last_activity_at) + Number(row.max_age_ms) >= Number(now)) continue;
          } else {
            if (row.status !== 'ended') continue;
            if (row.ended_at == null || row.retention_after_end_ms == null) continue;
            if (Number(row.ended_at) + Number(row.retention_after_end_ms) >= Number(now)) continue;
          }
          out.push({ identity: row.identity, stream_id: row.stream_id });
        }
        return { toArray: () => out };
      }

      if (q.startsWith('INSERT OR IGNORE INTO _wskit_stream_unsubscribed')) {
        const [identity, streamId, subscriberIdentity] = params;
        unsubscribed.add(key([identity, streamId, subscriberIdentity]));
        return { toArray: () => [] };
      }
      if (q.startsWith('SELECT 1 AS hit FROM _wskit_stream_unsubscribed')) {
        const [identity, streamId, subscriberIdentity] = params;
        return {
          toArray: () =>
            unsubscribed.has(key([identity, streamId, subscriberIdentity])) ? [{ hit: 1 }] : [],
        };
      }

      return { toArray: () => [] };
    },
  };
}

describe('durable-stream/storage', () => {
  let sql: ReturnType<typeof memorySql>;
  beforeEach(() => {
    sql = memorySql();
    Storage.ensureDurableStreamSchema(sql);
  });

  it('inserts and reads a stream row', () => {
    Storage.insertStream(sql, {
      identity: 'u-1',
      streamId: 's-1',
      event: 'ask-ai',
      payload: '{}',
      kind: 'recorded',
      now: 1_000,
      maxChunks: 10,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    });
    const row = Storage.readStream(sql, 'u-1', 's-1');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('recorded');
    expect(row!.status).toBe('active');
    expect(row!.maxChunks).toBe(10);
  });

  it('appendChunk + readChunksSince returns chunks in order', () => {
    Storage.insertStream(sql, {
      identity: 'u-1',
      streamId: 's-1',
      event: 'ask-ai',
      payload: '{}',
      kind: 'recorded',
      now: 1_000,
    });
    for (let seq = 1; seq <= 5; seq += 1) {
      Storage.appendChunk(sql, {
        identity: 'u-1',
        streamId: 's-1',
        seq,
        messageId: `m-${seq}`,
        payload: JSON.stringify({ n: seq }),
        now: 1_000 + seq,
      });
    }
    const chunks = Storage.readChunksSince(sql, 'u-1', 's-1', 2);
    expect(chunks.map((c) => c.seq)).toEqual([3, 4, 5]);
  });

  it('markSuspended only flips active → suspended', () => {
    Storage.insertStream(sql, {
      identity: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: 1_000,
    });
    Storage.markSuspended(sql, 'u-1', 's-1', 2_000);
    expect(Storage.readStream(sql, 'u-1', 's-1')!.status).toBe('suspended');
    // calling again is a no-op (only `active` flips).
    Storage.markSuspended(sql, 'u-1', 's-1', 3_000);
    expect(Storage.readStream(sql, 'u-1', 's-1')!.status).toBe('suspended');
  });

  it('markEnded sets status and ended_at', () => {
    Storage.insertStream(sql, {
      identity: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: 1_000,
    });
    Storage.markEnded(sql, 'u-1', 's-1', 5_000);
    const row = Storage.readStream(sql, 'u-1', 's-1')!;
    expect(row.status).toBe('ended');
    expect(row.endedAt).toBe(5_000);
  });

  it('deleteStream cascades chunk removal', () => {
    Storage.insertStream(sql, {
      identity: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: 1_000,
    });
    Storage.appendChunk(sql, {
      identity: 'u-1',
      streamId: 's-1',
      seq: 1,
      messageId: 'm-1',
      payload: '{}',
      now: 1_001,
    });
    Storage.deleteStream(sql, 'u-1', 's-1');
    expect(Storage.readStream(sql, 'u-1', 's-1')).toBeNull();
    expect(Storage.readChunksSince(sql, 'u-1', 's-1', 0)).toEqual([]);
  });

  it('findExpiredSuspended returns rows past their max_age_ms', () => {
    Storage.insertStream(sql, {
      identity: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: 1_000,
      maxAgeMs: 5_000,
    });
    Storage.markSuspended(sql, 'u-1', 's-1', 1_000);
    // 1_000 + 5_000 = 6_000 → still ok at 6_000.
    expect(Storage.findExpiredSuspended(sql, 6_000)).toEqual([]);
    expect(Storage.findExpiredSuspended(sql, 6_001)).toEqual([
      { identity: 'u-1', streamId: 's-1' },
    ]);
  });

  it('findExpiredEnded returns rows past retention', () => {
    Storage.insertStream(sql, {
      identity: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: 1_000,
      retentionAfterEndMs: 2_000,
    });
    Storage.markEnded(sql, 'u-1', 's-1', 1_000);
    expect(Storage.findExpiredEnded(sql, 2_999)).toEqual([]);
    expect(Storage.findExpiredEnded(sql, 3_001)).toEqual([{ identity: 'u-1', streamId: 's-1' }]);
  });

  it('insertStream turns a UNIQUE constraint error into StreamIdCollision', () => {
    sql.setConstraintMode(true);
    expect(() =>
      Storage.insertStream(sql, {
        identity: 'u-1',
        streamId: 's-1',
        event: 'e',
        payload: '{}',
        kind: 'recorded',
        now: 1_000,
      }),
    ).toThrow(/stream-id-collision/);
  });

  it('markUnsubscribed + isUnsubscribed round-trip', () => {
    Storage.insertStream(sql, {
      identity: '__bcast:top__',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: 1_000,
      broadcast: true,
      creatorIdentity: 'u-creator',
    });
    expect(Storage.isUnsubscribed(sql, '__bcast:top__', 's-1', 'u-peer')).toBe(false);
    Storage.markUnsubscribed(sql, '__bcast:top__', 's-1', 'u-peer', 2_000);
    expect(Storage.isUnsubscribed(sql, '__bcast:top__', 's-1', 'u-peer')).toBe(true);
    // Idempotent — INSERT OR IGNORE means a repeat is a no-op, not an error.
    expect(() =>
      Storage.markUnsubscribed(sql, '__bcast:top__', 's-1', 'u-peer', 3_000),
    ).not.toThrow();
  });
});
