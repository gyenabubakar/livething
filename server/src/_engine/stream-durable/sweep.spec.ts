import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import { sweepDurableStreams } from './runtime.ts';
import * as Storage from './storage.ts';

function countStreams(sql: ReturnType<typeof createTestSql>): number {
  return Number(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM __wskit_streams').one()!.n);
}

describe('sweepDurableStreams', () => {
  it('deletes nothing when no rows have expired yet', () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    Storage.insertStream(sql, {
      userId: 'u',
      streamId: 's1',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
      maxAgeMs: 60_000,
    });
    Storage.markSuspended(sql, { userId: 'u', streamId: 's1', now: Date.now() });
    const deleted = sweepDurableStreams({ sql });
    expect(deleted).toBe(0);
    expect(countStreams(sql)).toBe(1);
  });

  it('deletes suspended rows past maxAgeMs', () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    // Insert + suspend with maxAgeMs = 1ms in the past so it's immediately expired.
    const longAgo = Date.now() - 10_000;
    Storage.insertStream(sql, {
      userId: 'u',
      streamId: 's1',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: longAgo,
      maxAgeMs: 1,
    });
    Storage.markSuspended(sql, { userId: 'u', streamId: 's1', now: longAgo });
    const deleted = sweepDurableStreams({ sql });
    expect(deleted).toBe(1);
    expect(countStreams(sql)).toBe(0);
  });

  it('deletes ended rows past retentionAfterEndMs', () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const longAgo = Date.now() - 10_000;
    Storage.insertStream(sql, {
      userId: 'u',
      streamId: 's2',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: longAgo,
      retentionAfterEndMs: 1,
    });
    Storage.markEnded(sql, { userId: 'u', streamId: 's2', now: longAgo });
    const deleted = sweepDurableStreams({ sql });
    expect(deleted).toBe(1);
    expect(countStreams(sql)).toBe(0);
  });

  it('mixes suspended + ended in one sweep tick', () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const longAgo = Date.now() - 10_000;

    Storage.insertStream(sql, {
      userId: 'u',
      streamId: 'expired-suspended',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: longAgo,
      maxAgeMs: 1,
    });
    Storage.markSuspended(sql, { userId: 'u', streamId: 'expired-suspended', now: longAgo });

    Storage.insertStream(sql, {
      userId: 'u',
      streamId: 'expired-ended',
      event: 'e',
      payload: '{}',
      kind: 'recorded',
      now: longAgo,
      retentionAfterEndMs: 1,
    });
    Storage.markEnded(sql, { userId: 'u', streamId: 'expired-ended', now: longAgo });

    Storage.insertStream(sql, {
      userId: 'u',
      streamId: 'fresh',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: Date.now(),
      maxAgeMs: 60_000,
    });
    Storage.markSuspended(sql, { userId: 'u', streamId: 'fresh', now: Date.now() });

    const deleted = sweepDurableStreams({ sql });
    expect(deleted).toBe(2);
    expect(countStreams(sql)).toBe(1);
    expect(Storage.readStream(sql, 'u', 'fresh')).not.toBeNull();
  });
});
