import { createTestSql } from '~/_test/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Storage from './storage.ts';

describe('durable-stream/storage', () => {
  let sql: ReturnType<typeof createTestSql>;
  beforeEach(() => {
    sql = createTestSql();
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
    const input = {
      identity: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'recorded' as const,
      now: 1_000,
    };
    Storage.insertStream(sql, input);
    // A second insert on the same (identity, stream_id) hits the real PRIMARY
    // KEY constraint, which the helper surfaces as StreamIdCollision.
    expect(() => Storage.insertStream(sql, input)).toThrow(/stream-id-collision/);
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
