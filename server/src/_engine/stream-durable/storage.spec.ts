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
      userId: 'u-1',
      streamId: 's-1',
      event: 'ask-ai',
      payload: '{}',
      now: 1_000,
      maxChunks: 10,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    });
    const row = Storage.readStream(sql, 'u-1', 's-1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('active');
    expect(row!.interrupted).toBe(false);

    expect(row!.maxChunks).toBe(10);
  });

  it('appendChunk + readChunksSince returns chunks in order', () => {
    Storage.insertStream(sql, {
      userId: 'u-1',
      streamId: 's-1',
      event: 'ask-ai',
      payload: '{}',
      now: 1_000,
    });
    for (let seq = 1; seq <= 5; seq += 1) {
      Storage.appendChunk(sql, {
        userId: 'u-1',
        streamId: 's-1',
        seq,
        messageId: `m-${seq}`,
        payload: JSON.stringify({ n: seq }),
        now: 1_000 + seq,
      });
    }

    const chunks = Storage.readChunksSince(sql, { userId: 'u-1', streamId: 's-1', since: 2 });
    expect(chunks.map((c) => c.seq)).toEqual([3, 4, 5]);
  });

  it('markEnded records whether the generator was interrupted', () => {
    for (const streamId of ['finished', 'cut-off']) {
      Storage.insertStream(sql, { userId: 'u-1', streamId, event: 'e', payload: '{}', now: 1_000 });
    }

    Storage.markEnded(sql, { userId: 'u-1', streamId: 'finished', now: 2_000 });
    Storage.markEnded(sql, { userId: 'u-1', streamId: 'cut-off', now: 2_000, interrupted: true });

    expect(Storage.readStream(sql, 'u-1', 'finished')).toMatchObject({
      status: 'ended',
      interrupted: false,
    });
    expect(Storage.readStream(sql, 'u-1', 'cut-off')).toMatchObject({
      status: 'ended',
      interrupted: true,
    });
  });

  it('markSuspended only flips active → suspended', () => {
    Storage.insertStream(sql, {
      userId: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: 1_000,
    });
    Storage.markSuspended(sql, { userId: 'u-1', streamId: 's-1', now: 2_000 });
    expect(Storage.readStream(sql, 'u-1', 's-1')!.status).toBe('suspended');
    Storage.markSuspended(sql, { userId: 'u-1', streamId: 's-1', now: 3_000 });
    expect(Storage.readStream(sql, 'u-1', 's-1')!.status).toBe('suspended');
  });

  it('markEnded sets status and ended_at', () => {
    Storage.insertStream(sql, {
      userId: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: 1_000,
    });
    Storage.markEnded(sql, { userId: 'u-1', streamId: 's-1', now: 5_000 });
    const row = Storage.readStream(sql, 'u-1', 's-1')!;
    expect(row.status).toBe('ended');
    expect(row.endedAt).toBe(5_000);
  });

  it('deleteStream cascades chunk removal', () => {
    Storage.insertStream(sql, {
      userId: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: 1_000,
    });
    Storage.appendChunk(sql, {
      userId: 'u-1',
      streamId: 's-1',
      seq: 1,
      messageId: 'm-1',
      payload: '{}',
      now: 1_001,
    });
    Storage.deleteStream(sql, 'u-1', 's-1');
    expect(Storage.readStream(sql, 'u-1', 's-1')).toBeNull();

    expect(Storage.readChunksSince(sql, { userId: 'u-1', streamId: 's-1', since: 0 })).toEqual([]);
  });

  it('findExpiredSuspended returns rows past their max_age_ms', () => {
    Storage.insertStream(sql, {
      userId: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: 1_000,
      maxAgeMs: 5_000,
    });
    Storage.markSuspended(sql, { userId: 'u-1', streamId: 's-1', now: 1_000 });
    expect(Storage.findExpiredSuspended(sql, 6_000)).toEqual([]);
    expect(Storage.findExpiredSuspended(sql, 6_001)).toEqual([{ userId: 'u-1', streamId: 's-1' }]);
  });

  it('findExpiredEnded returns rows past retention', () => {
    Storage.insertStream(sql, {
      userId: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: 1_000,
      retentionAfterEndMs: 2_000,
    });
    Storage.markEnded(sql, { userId: 'u-1', streamId: 's-1', now: 1_000 });
    expect(Storage.findExpiredEnded(sql, 2_999)).toEqual([]);
    expect(Storage.findExpiredEnded(sql, 3_001)).toEqual([{ userId: 'u-1', streamId: 's-1' }]);
  });

  it('insertStream turns a UNIQUE constraint error into StreamIdCollision', () => {
    const input = {
      userId: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: 1_000,
    };

    Storage.insertStream(sql, input);
    // A second insert on the same (user_id, stream_id) hits the real PRIMARY
    // KEY constraint, which the helper surfaces as StreamIdCollision.
    expect(() => Storage.insertStream(sql, input)).toThrow(/stream-id-collision/);
  });

  it('markUnsubscribed + isUnsubscribed round-trip', () => {
    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: 1_000,
      broadcast: true,
      creatorUserId: 'u-creator',
    });
    expect(
      Storage.isUnsubscribed(sql, {
        storageUserId: '__bcast:top__',
        streamId: 's-1',
        subscriberUserId: 'u-peer',
      }),
    ).toBe(false);
    Storage.markUnsubscribed(sql, {
      storageUserId: '__bcast:top__',
      streamId: 's-1',
      subscriberUserId: 'u-peer',
      now: 2_000,
    });
    expect(
      Storage.isUnsubscribed(sql, {
        storageUserId: '__bcast:top__',
        streamId: 's-1',
        subscriberUserId: 'u-peer',
      }),
    ).toBe(true);
    // A repeat just refreshes the opt-out timestamp — it must not throw.
    expect(() =>
      Storage.markUnsubscribed(sql, {
        storageUserId: '__bcast:top__',
        streamId: 's-1',
        subscriberUserId: 'u-peer',
        now: 3_000,
      }),
    ).not.toThrow();
  });
});

describe('durable-stream/storage — purgeStreamsByUser', () => {
  let sql: ReturnType<typeof createTestSql>;
  beforeEach(() => {
    sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
  });

  it("drops the purged user's stream and chunk rows, leaving another user's stream intact", () => {
    Storage.insertStream(sql, {
      userId: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      now: 1_000,
    });
    Storage.appendChunk(sql, {
      userId: 'u-1',
      streamId: 's-1',
      seq: 1,
      messageId: 'm-1',
      payload: '{}',
      now: 1_001,
    });
    Storage.insertStream(sql, {
      userId: 'u-2',
      streamId: 's-2',
      event: 'e',
      payload: '{}',
      now: 1_000,
    });
    Storage.appendChunk(sql, {
      userId: 'u-2',
      streamId: 's-2',
      seq: 1,
      messageId: 'm-1',
      payload: '{}',
      now: 1_001,
    });

    Storage.purgeStreamsByUser(sql, 'u-1');

    expect(Storage.readStream(sql, 'u-1', 's-1')).toBeNull();
    expect(Storage.readChunksSince(sql, { userId: 'u-1', streamId: 's-1', since: 0 })).toEqual([]);
    expect(Storage.readStream(sql, 'u-2', 's-2')).not.toBeNull();
    expect(Storage.readChunksSince(sql, { userId: 'u-2', streamId: 's-2', since: 0 })).toHaveLength(
      1,
    );
  });

  it('drops subscriber rows the purged user owns as a stream, and rows where they merely subscribe to someone else', () => {
    Storage.insertStream(sql, {
      userId: '__bcast:top__',
      streamId: 's-owned-by-purged',
      event: 'e',
      payload: '{}',
      now: 1_000,
      broadcast: true,
    });
    Storage.seedSubscriber(sql, {
      storageUserId: '__bcast:top__',
      streamId: 's-owned-by-purged',
      subscriberUserId: 'u-1',
    });
    Storage.insertStream(sql, {
      userId: '__bcast:other__',
      streamId: 's-owned-by-other',
      event: 'e',
      payload: '{}',
      now: 1_000,
      broadcast: true,
    });
    Storage.seedSubscriber(sql, {
      storageUserId: '__bcast:other__',
      streamId: 's-owned-by-other',
      subscriberUserId: 'u-1',
    });
    Storage.seedSubscriber(sql, {
      storageUserId: '__bcast:other__',
      streamId: 's-owned-by-other',
      subscriberUserId: 'u-2',
    });

    Storage.purgeStreamsByUser(sql, 'u-1');

    expect(
      Storage.getSubscriber(sql, {
        storageUserId: '__bcast:other__',
        streamId: 's-owned-by-other',
        subscriberUserId: 'u-1',
      }),
    ).toBeNull();
    expect(
      Storage.getSubscriber(sql, {
        storageUserId: '__bcast:other__',
        streamId: 's-owned-by-other',
        subscriberUserId: 'u-2',
      }),
    ).not.toBeNull();
  });

  function insertBroadcastStreamCreatedByAlice(): void {
    Storage.insertStream(sql, {
      userId: '__bcast:ch:room__',
      streamId: 's-broadcast',
      event: 'e',
      payload: '{}',
      now: 1_000,
      broadcast: true,
      creatorUserId: 'alice',
    });
    Storage.appendChunk(sql, {
      userId: '__bcast:ch:room__',
      streamId: 's-broadcast',
      seq: 1,
      messageId: 'm-1',
      payload: '{}',
      now: 1_001,
    });
    Storage.seedSubscriber(sql, {
      storageUserId: '__bcast:ch:room__',
      streamId: 's-broadcast',
      subscriberUserId: 'bob',
    });
  }

  it('by default deletes a broadcast stream the purged user created, plus its chunks and subscribers', () => {
    insertBroadcastStreamCreatedByAlice();

    Storage.purgeStreamsByUser(sql, 'alice');

    expect(Storage.readStream(sql, '__bcast:ch:room__', 's-broadcast')).toBeNull();
    expect(
      Storage.readChunksSince(sql, {
        userId: '__bcast:ch:room__',
        streamId: 's-broadcast',
        since: 0,
      }),
    ).toEqual([]);
    expect(
      Storage.getSubscriber(sql, {
        storageUserId: '__bcast:ch:room__',
        streamId: 's-broadcast',
        subscriberUserId: 'bob',
      }),
    ).toBeNull();
  });

  it('keepBroadcastContent: true keeps the broadcast stream, its chunks and its subscribers', () => {
    insertBroadcastStreamCreatedByAlice();

    Storage.purgeStreamsByUser(sql, 'alice', { keepBroadcastContent: true });

    const row = Storage.readStream(sql, '__bcast:ch:room__', 's-broadcast');
    expect(row).not.toBeNull();
    expect(
      Storage.readChunksSince(sql, {
        userId: '__bcast:ch:room__',
        streamId: 's-broadcast',
        since: 0,
      }),
    ).toHaveLength(1);
    expect(
      Storage.getSubscriber(sql, {
        storageUserId: '__bcast:ch:room__',
        streamId: 's-broadcast',
        subscriberUserId: 'bob',
      }),
    ).not.toBeNull();
  });

  it('keepBroadcastContent: true still clears creator_user_id, since the user is gone', () => {
    insertBroadcastStreamCreatedByAlice();

    Storage.purgeStreamsByUser(sql, 'alice', { keepBroadcastContent: true });

    const row = Storage.readStream(sql, '__bcast:ch:room__', 's-broadcast');
    expect(row?.creatorUserId).toBeNull();
  });

  it("with no options at all, still purges rows filed under the user's own storage key", () => {
    Storage.insertStream(sql, {
      userId: 'u-1',
      streamId: 's-own',
      event: 'e',
      payload: '{}',
      now: 1_000,
    });

    Storage.purgeStreamsByUser(sql, 'u-1');

    expect(Storage.readStream(sql, 'u-1', 's-own')).toBeNull();
  });
});
