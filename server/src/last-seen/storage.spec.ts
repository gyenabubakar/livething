import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import {
  ensureLastSeenSchema,
  purgeLastSeenByUser,
  readLastSeen,
  readLastSeenMany,
  stampLastSeen,
} from './storage.ts';

function setup(limits?: { maxBoundParams: number }) {
  const sql = createTestSql(limits ? { limits } : undefined);
  ensureLastSeenSchema(sql);
  return sql;
}

describe('last-seen/storage — purgeLastSeenByUser', () => {
  it("drops one user id's row, leaving another user id intact", () => {
    const sql = setup();
    stampLastSeen(sql, { userId: 'alice', now: 1000 });
    stampLastSeen(sql, { userId: 'bob', now: 1000 });

    purgeLastSeenByUser(sql, 'alice');

    expect(readLastSeen(sql, 'alice')).toBeNull();
    expect(readLastSeen(sql, 'bob')).toBe(1000);
  });

  it('is a no-op when the table has no row for that user', () => {
    const sql = setup();
    expect(() => purgeLastSeenByUser(sql, 'nobody')).not.toThrow();
  });
});

describe('last-seen/storage — readLastSeenMany batching', () => {
  it('reads a roster below the bound-parameter cap in one statement', () => {
    const sql = setup({ maxBoundParams: 4 });
    stampLastSeen(sql, { userId: 'alice', now: 1 });
    stampLastSeen(sql, { userId: 'bob', now: 2 });
    stampLastSeen(sql, { userId: 'carol', now: 3 });

    const map = readLastSeenMany(sql, ['alice', 'bob', 'carol', 'missing']);

    expect(map.get('alice')).toBe(1);
    expect(map.get('bob')).toBe(2);
    expect(map.get('carol')).toBe(3);
    expect(map.has('missing')).toBe(false);
  });

  it('reads a roster exactly at the bound-parameter cap', () => {
    const sql = setup({ maxBoundParams: 4 });
    const userIds = ['u1', 'u2', 'u3', 'u4'];
    for (const [index, userId] of userIds.entries()) {
      stampLastSeen(sql, { userId, now: index + 1 });
    }

    const map = readLastSeenMany(sql, userIds);

    for (const [index, userId] of userIds.entries()) {
      expect(map.get(userId)).toBe(index + 1);
    }
  });

  it('reads a roster spanning several batches above the bound-parameter cap', () => {
    const sql = setup({ maxBoundParams: 4 });
    const userIds = Array.from({ length: 11 }, (_, i) => `user_${i}`);
    for (const [index, userId] of userIds.entries()) {
      stampLastSeen(sql, { userId, now: index + 1 });
    }

    const map = readLastSeenMany(sql, userIds);

    expect(map.size).toBe(11);
    for (const [index, userId] of userIds.entries()) {
      expect(map.get(userId)).toBe(index + 1);
    }
  });

  it('returns an empty map for an empty roster without querying', () => {
    const sql = setup({ maxBoundParams: 4 });
    expect(readLastSeenMany(sql, [])).toEqual(new Map());
  });
});
