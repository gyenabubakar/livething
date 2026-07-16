import { createTestSql } from '~/_test/sql.ts';
import { ensurePersistenceSchema } from '~/persistence/storage.ts';
import {
  deleteGroup,
  deleteTag,
  insertTag,
  listGroupNames,
  listTagsByIdentity,
} from '~/tags/storage.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SQLProvider } from '~/context.ts';

describe('tags storage', () => {
  let sql: SQLProvider;

  beforeEach(() => {
    sql = createTestSql();
    ensurePersistenceSchema(sql);
  });

  it('round-trips a tag through insert and read', () => {
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'admin', addedAt: 1000 });
    expect(listTagsByIdentity(sql, 'u-1')).toEqual([
      { group: 'role', key: 'admin', addedAt: 1000 },
    ]);
  });

  it('deduplicates on the (identity, group, key) primary key, keeping the latest addedAt', () => {
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'admin', addedAt: 1000 });
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'admin', addedAt: 5000 });
    const tags = listTagsByIdentity(sql, 'u-1');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.addedAt).toBe(5000);
  });

  it('deleteTag removes exactly the one row and leaves the rest untouched', () => {
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'admin', addedAt: 1000 });
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'editor', addedAt: 2000 });
    insertTag(sql, { identity: 'u-1', group: 'team', key: 'admin', addedAt: 3000 });
    insertTag(sql, { identity: 'u-2', group: 'role', key: 'admin', addedAt: 4000 });

    deleteTag(sql, { identity: 'u-1', group: 'role', key: 'admin' });

    // Same key under a different group, and the same group+key under a different
    // identity, must survive — only the exact three-part match is removed.
    expect(
      listTagsByIdentity(sql, 'u-1')
        .map((t) => `${t.group}:${t.key}`)
        .sort(),
    ).toEqual(['role:editor', 'team:admin']);
    expect(listTagsByIdentity(sql, 'u-2').map((t) => t.key)).toEqual(['admin']);
  });

  it('deleteTag is a no-op when the row does not exist', () => {
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'admin', addedAt: 1000 });
    expect(() => deleteTag(sql, { identity: 'u-1', group: 'role', key: 'missing' })).not.toThrow();
    expect(listTagsByIdentity(sql, 'u-1')).toHaveLength(1);
  });

  it('listTagsByIdentity returns only rows for that identity', () => {
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { identity: 'u-2', group: 'role', key: 'editor' });
    expect(listTagsByIdentity(sql, 'u-1')).toHaveLength(1);
    expect(listTagsByIdentity(sql, 'unknown')).toHaveLength(0);
  });

  it('listGroupNames returns each group once across every identity', () => {
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { identity: 'u-2', group: 'role', key: 'editor' });
    insertTag(sql, { identity: 'u-1', group: 'team', key: 'eng' });
    expect([...listGroupNames(sql)].sort()).toEqual(['role', 'team']);
  });

  it('deleteGroup drops every row of one group across all identities', () => {
    insertTag(sql, { identity: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { identity: 'u-2', group: 'role', key: 'editor' });
    insertTag(sql, { identity: 'u-1', group: 'team', key: 'eng' });

    deleteGroup(sql, 'role');

    expect(listTagsByIdentity(sql, 'u-1').map((t) => t.group)).toEqual(['team']);
    expect(listTagsByIdentity(sql, 'u-2')).toHaveLength(0);
    expect([...listGroupNames(sql)]).toEqual(['team']);
  });
});
