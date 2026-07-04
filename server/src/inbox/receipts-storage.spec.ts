import { describe, expect, it } from 'vitest';
import {
  advanceReceivedThrough,
  advanceSeenThrough,
  ensureReceiptsSchema,
  listReceivedBy,
  listSeenBy,
} from './receipts-storage.ts';
import { createTestSql } from './test-sql.ts';

function setup() {
  const sql = createTestSql();
  ensureReceiptsSchema(sql);
  return sql;
}

const room = { channelName: 'room', channelFamily: null };

describe('receipts-storage — received cursor', () => {
  it('advances cumulatively and reports changed only when it moves', () => {
    const sql = setup();
    function advance(receivedThrough: number) {
      return advanceReceivedThrough(sql, { ...room, identity: 'alice', receivedThrough, now: 1 });
    }

    expect(advance(5)).toEqual({ receivedThrough: 5, seenThrough: 0, changed: true });
    expect(advance(3)).toEqual({ receivedThrough: 5, seenThrough: 0, changed: false });
    expect(advance(5)).toEqual({ receivedThrough: 5, seenThrough: 0, changed: false });
    expect(advance(9)).toEqual({ receivedThrough: 9, seenThrough: 0, changed: true });
  });
});

describe('receipts-storage — seen cursor', () => {
  it('pulls received up so seen never runs ahead of received', () => {
    const sql = setup();
    const result = advanceSeenThrough(sql, { ...room, identity: 'alice', seenThrough: 7, now: 1 });
    expect(result).toEqual({ receivedThrough: 7, seenThrough: 7, changed: true });
  });

  it('pulls received up to a seen mark ahead of it (seen implies received)', () => {
    const sql = setup();
    advanceReceivedThrough(sql, { ...room, identity: 'alice', receivedThrough: 10, now: 1 });
    const result = advanceSeenThrough(sql, { ...room, identity: 'alice', seenThrough: 20, now: 2 });
    expect(result).toEqual({ receivedThrough: 20, seenThrough: 20, changed: true });
  });

  it('never lets seen exceed received when a later lower seen arrives', () => {
    const sql = setup();
    advanceSeenThrough(sql, { ...room, identity: 'alice', seenThrough: 15, now: 1 });
    // received is now 15, seen 15. A lower seen mark cannot lower either cursor.
    const result = advanceSeenThrough(sql, { ...room, identity: 'alice', seenThrough: 8, now: 2 });
    expect(result).toEqual({ receivedThrough: 15, seenThrough: 15, changed: false });
  });

  it('is a no-op when neither cursor moves', () => {
    const sql = setup();
    advanceSeenThrough(sql, { ...room, identity: 'alice', seenThrough: 5, now: 1 });
    const again = advanceSeenThrough(sql, { ...room, identity: 'alice', seenThrough: 3, now: 2 });
    expect(again).toEqual({ receivedThrough: 5, seenThrough: 5, changed: false });
  });
});

describe('receipts-storage — enumeration', () => {
  it('lists identities whose received/seen cursor has reached seq', () => {
    const sql = setup();
    advanceReceivedThrough(sql, { ...room, identity: 'alice', receivedThrough: 10, now: 1 });
    advanceReceivedThrough(sql, { ...room, identity: 'bob', receivedThrough: 4, now: 1 });
    advanceSeenThrough(sql, { ...room, identity: 'alice', seenThrough: 8, now: 1 });

    expect(listReceivedBy(sql, { ...room, seq: 5 }).sort()).toEqual(['alice']);
    expect(listReceivedBy(sql, { ...room, seq: 4 }).sort()).toEqual(['alice', 'bob']);
    expect(listSeenBy(sql, { ...room, seq: 8 })).toEqual(['alice']);
    expect(listSeenBy(sql, { ...room, seq: 9 })).toEqual([]);
  });

  it('keys a family channel separately from a static one of the same name', () => {
    const sql = setup();
    advanceReceivedThrough(sql, {
      channelName: 'room',
      channelFamily: 'rooms',
      identity: 'alice',
      receivedThrough: 5,
      now: 1,
    });

    expect(listReceivedBy(sql, { channelName: 'room', channelFamily: null, seq: 1 })).toEqual([]);
    expect(listReceivedBy(sql, { channelName: 'room', channelFamily: 'rooms', seq: 1 })).toEqual([
      'alice',
    ]);
  });
});
