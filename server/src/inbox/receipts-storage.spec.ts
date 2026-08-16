import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import {
  advanceReadThrough,
  advanceReceivedThrough,
  clearCacheEntriesForUser,
  ensureReceiptsSchema,
  listReaders,
  listReceivers,
  purgeReceiptsByUser,
} from './receipts-storage.ts';

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
      return advanceReceivedThrough(sql, { ...room, userId: 'alice', receivedThrough, now: 1 });
    }

    expect(advance(5)).toEqual({ receivedThrough: 5, readThrough: 0, changed: true });
    expect(advance(3)).toEqual({ receivedThrough: 5, readThrough: 0, changed: false });
    expect(advance(5)).toEqual({ receivedThrough: 5, readThrough: 0, changed: false });
    expect(advance(9)).toEqual({ receivedThrough: 9, readThrough: 0, changed: true });
  });
});

describe('receipts-storage — read cursor', () => {
  it('pulls received up so read never runs ahead of received', () => {
    const sql = setup();
    const result = advanceReadThrough(sql, { ...room, userId: 'alice', readThrough: 7, now: 1 });
    expect(result).toEqual({
      receivedThrough: 7,
      readThrough: 7,
      changed: true,
      receivedChanged: true,
    });
  });

  it('pulls received up to a read mark ahead of it (read implies received)', () => {
    const sql = setup();
    advanceReceivedThrough(sql, { ...room, userId: 'alice', receivedThrough: 10, now: 1 });
    const result = advanceReadThrough(sql, { ...room, userId: 'alice', readThrough: 20, now: 2 });
    expect(result).toEqual({
      receivedThrough: 20,
      readThrough: 20,
      changed: true,
      receivedChanged: true,
    });
  });

  it('leaves received untouched when the read mark is already delivered', () => {
    const sql = setup();
    advanceReceivedThrough(sql, { ...room, userId: 'alice', receivedThrough: 10, now: 1 });
    const result = advanceReadThrough(sql, { ...room, userId: 'alice', readThrough: 6, now: 2 });
    expect(result).toEqual({
      receivedThrough: 10,
      readThrough: 6,
      changed: true,
      receivedChanged: false,
    });
  });

  it('never lets read exceed received when a later lower read arrives', () => {
    const sql = setup();
    advanceReadThrough(sql, { ...room, userId: 'alice', readThrough: 15, now: 1 });
    // received is now 15, read 15. A lower read mark cannot lower either cursor.
    const result = advanceReadThrough(sql, { ...room, userId: 'alice', readThrough: 8, now: 2 });
    expect(result).toEqual({
      receivedThrough: 15,
      readThrough: 15,
      changed: false,
      receivedChanged: false,
    });
  });

  it('is a no-op when neither cursor moves', () => {
    const sql = setup();
    advanceReadThrough(sql, { ...room, userId: 'alice', readThrough: 5, now: 1 });
    const again = advanceReadThrough(sql, { ...room, userId: 'alice', readThrough: 3, now: 2 });
    expect(again).toEqual({
      receivedThrough: 5,
      readThrough: 5,
      changed: false,
      receivedChanged: false,
    });
  });
});

describe('receipts-storage — enumeration', () => {
  it('lists user ids whose received/read cursor has reached seq', () => {
    const sql = setup();
    advanceReceivedThrough(sql, { ...room, userId: 'alice', receivedThrough: 10, now: 1 });
    advanceReceivedThrough(sql, { ...room, userId: 'bob', receivedThrough: 4, now: 1 });
    advanceReadThrough(sql, { ...room, userId: 'alice', readThrough: 8, now: 1 });

    expect(listReceivers(sql, { ...room, seq: 5 }).sort()).toEqual(['alice']);
    expect(listReceivers(sql, { ...room, seq: 4 }).sort()).toEqual(['alice', 'bob']);
    expect(listReaders(sql, { ...room, seq: 8 })).toEqual(['alice']);
    expect(listReaders(sql, { ...room, seq: 9 })).toEqual([]);
  });

  it('keys a family channel separately from a static one of the same name', () => {
    const sql = setup();
    advanceReceivedThrough(sql, {
      channelName: 'room',
      channelFamily: 'rooms',
      userId: 'alice',
      receivedThrough: 5,
      now: 1,
    });

    expect(listReceivers(sql, { channelName: 'room', channelFamily: null, seq: 1 })).toEqual([]);
    expect(listReceivers(sql, { channelName: 'room', channelFamily: 'rooms', seq: 1 })).toEqual([
      'alice',
    ]);
  });
});

describe('receipts-storage — purgeReceiptsByUser', () => {
  it("drops one user id's receipt rows across channels, leaving another user id intact", () => {
    const sql = setup();
    advanceReceivedThrough(sql, { ...room, userId: 'alice', receivedThrough: 5, now: 1 });
    advanceReceivedThrough(sql, {
      channelName: 'other-room',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 2,
      now: 1,
    });
    advanceReceivedThrough(sql, { ...room, userId: 'bob', receivedThrough: 5, now: 1 });

    purgeReceiptsByUser(sql, 'alice');

    expect(listReceivers(sql, { ...room, seq: 1 })).toEqual(['bob']);
    expect(listReceivers(sql, { channelName: 'other-room', channelFamily: null, seq: 1 })).toEqual(
      [],
    );
  });
});

describe('receipts-storage — clearCacheEntriesForUser', () => {
  it("removes one user's cursor cache entries across channels, leaving another user's intact", () => {
    const sql = setup();
    const cache = new Map<string, { receivedThrough: number; readThrough: number }>();
    advanceReceivedThrough(sql, { ...room, userId: 'alice', receivedThrough: 5, now: 1 }, cache);
    advanceReceivedThrough(
      sql,
      {
        channelName: 'other-room',
        channelFamily: null,
        userId: 'alice',
        receivedThrough: 2,
        now: 1,
      },
      cache,
    );
    advanceReceivedThrough(sql, { ...room, userId: 'bob', receivedThrough: 5, now: 1 }, cache);
    expect(cache.size).toBe(3);

    clearCacheEntriesForUser(cache, 'alice');

    expect([...cache.keys()]).toEqual(['room  bob']);
  });

  it('does not remove a user id that is only a suffix of another key', () => {
    const cache = new Map<string, number>([
      ['room  5', 1],
      ['room  105', 2],
    ]);

    clearCacheEntriesForUser(cache, '5');

    expect([...cache.keys()]).toEqual(['room  105']);
  });

  it('is a no-op on an empty cache', () => {
    const cache = new Map<string, number>();
    expect(() => clearCacheEntriesForUser(cache, 'alice')).not.toThrow();
    expect(cache.size).toBe(0);
  });
});
