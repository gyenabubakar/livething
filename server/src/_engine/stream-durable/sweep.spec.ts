/* oxlint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { sweepDurableStreams } from './runtime.ts';
import * as Storage from './storage.ts';

// Minimal in-memory SQL that just tracks streams + chunks enough for sweep.
function makeSql() {
  const streams = new Map<string, Record<string, unknown>>();
  const chunks = new Map<string, Record<string, unknown>>();
  function key(parts: unknown[]): string {
    return parts.join('|');
  }

  const sql = {
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
          started_at: startedAt,
          last_activity_at: lastActivityAt,
          ended_at: null,
          max_chunks: maxChunks,
          max_age_ms: maxAgeMs,
          retention_after_end_ms: retentionAfterEndMs,
        });
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
      if (q.startsWith('DELETE FROM _wskit_streams')) {
        const [identity, streamId] = params;
        streams.delete(key([identity, streamId]));
        for (const k of [...chunks.keys()]) {
          if (k.startsWith(key([identity, streamId]) + '|')) chunks.delete(k);
        }
        return { toArray: () => [] };
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
      return { toArray: () => [] };
    },
  };
  return sql;
}

describe('sweepDurableStreams', () => {
  it('deletes nothing when no rows have expired yet', () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    Storage.insertStream(sql, {
      identity: 'u',
      streamId: 's1',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
      maxAgeMs: 60_000,
    });
    Storage.markSuspended(sql, 'u', 's1', Date.now());
    const deleted = sweepDurableStreams({ sql });
    expect(deleted).toBe(0);
    expect(sql.streams.size).toBe(1);
  });

  it('deletes suspended rows past maxAgeMs', () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    // Insert + suspend with maxAgeMs = 1ms in the past so it's immediately expired.
    const longAgo = Date.now() - 10_000;
    Storage.insertStream(sql, {
      identity: 'u',
      streamId: 's1',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: longAgo,
      maxAgeMs: 1,
    });
    Storage.markSuspended(sql, 'u', 's1', longAgo);
    const deleted = sweepDurableStreams({ sql });
    expect(deleted).toBe(1);
    expect(sql.streams.size).toBe(0);
  });

  it('deletes ended rows past retentionAfterEndMs', () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const longAgo = Date.now() - 10_000;
    Storage.insertStream(sql, {
      identity: 'u',
      streamId: 's2',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: longAgo,
      retentionAfterEndMs: 1,
    });
    Storage.markEnded(sql, 'u', 's2', longAgo);
    const deleted = sweepDurableStreams({ sql });
    expect(deleted).toBe(1);
    expect(sql.streams.size).toBe(0);
  });

  it('mixes suspended + ended in one sweep tick', () => {
    const sql = makeSql();
    Storage.ensureDurableStreamSchema(sql);
    const longAgo = Date.now() - 10_000;

    Storage.insertStream(sql, {
      identity: 'u',
      streamId: 'expired-suspended',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: longAgo,
      maxAgeMs: 1,
    });
    Storage.markSuspended(sql, 'u', 'expired-suspended', longAgo);

    Storage.insertStream(sql, {
      identity: 'u',
      streamId: 'expired-ended',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: longAgo,
      retentionAfterEndMs: 1,
    });
    Storage.markEnded(sql, 'u', 'expired-ended', longAgo);

    Storage.insertStream(sql, {
      identity: 'u',
      streamId: 'fresh',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
      maxAgeMs: 60_000,
    });
    Storage.markSuspended(sql, 'u', 'fresh', Date.now());

    const deleted = sweepDurableStreams({ sql });
    expect(deleted).toBe(2);
    expect(sql.streams.size).toBe(1);
    expect(sql.streams.has('u|fresh')).toBe(true);
  });
});
