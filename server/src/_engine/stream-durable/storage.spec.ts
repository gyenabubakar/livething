/* oxlint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Storage from './storage.ts';

// In-memory SQL stub that satisfies the storage helpers. Just enough to
// exercise the CRUD paths; not a faithful sqlite implementation.
function memorySql() {
  const streams = new Map<string, Record<string, unknown>>();
  const chunks = new Map<string, Record<string, unknown>>();
  const subscribers = new Map<string, { caught_up_seq: unknown; unsubscribed_at: unknown }>();
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

      if (q.startsWith('INSERT INTO __wskit_streams')) {
        if (raiseConstraint) {
          throw new Error(
            'UNIQUE constraint failed: __wskit_streams.identity, __wskit_streams.stream_id',
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

      if (q.startsWith('SELECT * FROM __wskit_streams WHERE identity')) {
        const [identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        return { toArray: () => (row ? [row] : []) };
      }

      if (q.startsWith('UPDATE __wskit_streams SET cursor')) {
        const [cursor, lastSeq, now, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row) {
          row.cursor = cursor;
          row.last_seq = lastSeq;
          row.last_activity_at = now;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith('UPDATE __wskit_streams SET last_seq')) {
        const [lastSeq, now, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row) {
          row.last_seq = lastSeq;
          row.last_activity_at = now;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith("UPDATE __wskit_streams SET status = 'suspended'")) {
        const [now, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row && row.status === 'active') {
          row.status = 'suspended';
          row.last_activity_at = now;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith("UPDATE __wskit_streams SET status = 'ended'")) {
        const [now, lastActivityAt, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row) {
          row.status = 'ended';
          row.ended_at = now;
          row.last_activity_at = lastActivityAt;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith("UPDATE __wskit_streams SET status = 'active'")) {
        const [now, identity, streamId] = params;
        const row = streams.get(key([identity, streamId]));
        if (row) {
          row.status = 'active';
          row.last_activity_at = now;
        }
        return { toArray: () => [] };
      }
      if (q.startsWith('DELETE FROM __wskit_streams')) {
        const [identity, streamId] = params;
        streams.delete(key([identity, streamId]));
        // emulate ON DELETE CASCADE
        for (const k of [...chunks.keys()]) {
          if (k.startsWith(key([identity, streamId]) + '|')) chunks.delete(k);
        }
        for (const k of [...subscribers.keys()]) {
          if (k.startsWith(key([identity, streamId]) + '|')) subscribers.delete(k);
        }
        return { toArray: () => [] };
      }

      if (q.startsWith('INSERT INTO __wskit_stream_chunks')) {
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
      if (q.startsWith('SELECT * FROM __wskit_stream_chunks')) {
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
      if (q.startsWith('SELECT COUNT(*) AS n FROM __wskit_stream_chunks')) {
        const [identity, streamId] = params;
        let n = 0;
        for (const row of chunks.values()) {
          if (row.identity === identity && row.stream_id === streamId) n += 1;
        }
        return { toArray: () => [{ n }] };
      }

      if (q.startsWith('SELECT identity, stream_id FROM __wskit_streams')) {
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

      if (q.startsWith('INSERT OR IGNORE INTO __wskit_stream_subscribers')) {
        const [identity, streamId, subscriberIdentity] = params;
        const k = key([identity, streamId, subscriberIdentity]);
        if (!subscribers.has(k)) subscribers.set(k, { caught_up_seq: 0, unsubscribed_at: null });
        return { toArray: () => [] };
      }
      if (q.startsWith('INSERT INTO __wskit_stream_subscribers')) {
        const [identity, streamId, subscriberIdentity, value] = params;
        const k = key([identity, streamId, subscriberIdentity]);
        const row = subscribers.get(k) ?? { caught_up_seq: 0, unsubscribed_at: null };
        if (q.includes('DO UPDATE SET caught_up_seq')) row.caught_up_seq = value;
        else row.unsubscribed_at = value;
        subscribers.set(k, row);
        return { toArray: () => [] };
      }
      if (q.startsWith('SELECT caught_up_seq, unsubscribed_at FROM __wskit_stream_subscribers')) {
        const [identity, streamId, subscriberIdentity] = params;
        const row = subscribers.get(key([identity, streamId, subscriberIdentity]));
        return { toArray: () => (row ? [{ ...row }] : []) };
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
    const chunks = Storage.readChunksSince(sql, { identity: 'u-1', streamId: 's-1', since: 2 });
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
    Storage.markSuspended(sql, { identity: 'u-1', streamId: 's-1', now: 2_000 });
    expect(Storage.readStream(sql, 'u-1', 's-1')!.status).toBe('suspended');
    // calling again is a no-op (only `active` flips).
    Storage.markSuspended(sql, { identity: 'u-1', streamId: 's-1', now: 3_000 });
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
    Storage.markEnded(sql, { identity: 'u-1', streamId: 's-1', now: 5_000 });
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
    expect(Storage.readChunksSince(sql, { identity: 'u-1', streamId: 's-1', since: 0 })).toEqual(
      [],
    );
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
    Storage.markSuspended(sql, { identity: 'u-1', streamId: 's-1', now: 1_000 });
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
    Storage.markEnded(sql, { identity: 'u-1', streamId: 's-1', now: 1_000 });
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
    expect(
      Storage.isUnsubscribed(sql, {
        storageIdentity: '__bcast:top__',
        streamId: 's-1',
        subscriberIdentity: 'u-peer',
      }),
    ).toBe(false);
    Storage.markUnsubscribed(sql, {
      storageIdentity: '__bcast:top__',
      streamId: 's-1',
      subscriberIdentity: 'u-peer',
      now: 2_000,
    });
    expect(
      Storage.isUnsubscribed(sql, {
        storageIdentity: '__bcast:top__',
        streamId: 's-1',
        subscriberIdentity: 'u-peer',
      }),
    ).toBe(true);
    // A repeat just refreshes the opt-out timestamp — it must not throw.
    expect(() =>
      Storage.markUnsubscribed(sql, {
        storageIdentity: '__bcast:top__',
        streamId: 's-1',
        subscriberIdentity: 'u-peer',
        now: 3_000,
      }),
    ).not.toThrow();
  });
});
