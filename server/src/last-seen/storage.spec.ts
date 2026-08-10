import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import {
  ensureLastSeenSchema,
  purgeLastSeenByUser,
  readLastSeen,
  stampLastSeen,
} from './storage.ts';

function setup() {
  const sql = createTestSql();
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
