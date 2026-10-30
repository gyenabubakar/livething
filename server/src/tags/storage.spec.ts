import { createTestSql } from '~/_test/sql.ts';
import {
  deleteTag,
  ensureTagsSchema,
  insertTag,
  listTagsByUser,
  purgeTagsByUser,
} from '~/tags/storage.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SQLProvider } from '~/context.ts';

describe('tags storage', () => {
  let sql: SQLProvider;

  beforeEach(() => {
    sql = createTestSql();
    ensureTagsSchema(sql);
  });

  it('creates the table and both indexes', () => {
    const created = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
      .toArray()
      .map((row) => row.name);
    expect(created).toContain('__livething_tags');
    expect(created).toContain('__livething_idx_tags_user');
    expect(created).toContain('__livething_idx_tags_group_key');
  });

  it('purgeTagsByUser is a no-op when the tag table is empty', () => {
    expect(() => purgeTagsByUser(sql, 'u-1')).not.toThrow();
  });

  it('purgeTagsByUser drops every row for that user', () => {
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { userId: 'u-1', group: 'team', key: 'eng' });
    insertTag(sql, { userId: 'u-2', group: 'role', key: 'admin' });
    purgeTagsByUser(sql, 'u-1');
    expect(listTagsByUser(sql, 'u-1')).toHaveLength(0);

    expect(listTagsByUser(sql, 'u-2')).toHaveLength(1);
  });

  it('round-trips a tag through insert and read', () => {
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    expect(listTagsByUser(sql, 'u-1')).toEqual([{ group: 'role', key: 'admin' }]);
  });

  it('deduplicates on the (user_id, group, key) primary key', () => {
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    const tags = listTagsByUser(sql, 'u-1');
    expect(tags).toHaveLength(1);
  });

  it('deleteTag removes exactly the one row and leaves the rest untouched', () => {
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'editor' });
    insertTag(sql, { userId: 'u-1', group: 'team', key: 'admin' });
    insertTag(sql, { userId: 'u-2', group: 'role', key: 'admin' });

    deleteTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });

    // Same key under a different group, and the same group+key under a different
    // user, must survive — only the exact three-part match is removed.
    expect(
      listTagsByUser(sql, 'u-1')
        .map((t) => `${t.group}:${t.key}`)
        .sort(),
    ).toEqual(['role:editor', 'team:admin']);
    expect(listTagsByUser(sql, 'u-2').map((t) => t.key)).toEqual(['admin']);
  });

  it('deleteTag is a no-op when the row does not exist', () => {
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    expect(() => deleteTag(sql, { userId: 'u-1', group: 'role', key: 'missing' })).not.toThrow();
    expect(listTagsByUser(sql, 'u-1')).toHaveLength(1);
  });

  it('listTagsByUser returns only rows for that user', () => {
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { userId: 'u-2', group: 'role', key: 'editor' });
    expect(listTagsByUser(sql, 'u-1')).toHaveLength(1);
    expect(listTagsByUser(sql, 'unknown')).toHaveLength(0);
  });
});
