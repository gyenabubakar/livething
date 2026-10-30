import { LiveThingConfigError } from '@livething/core';
import { createTestSql } from '~/_test/sql.ts';
import { restorePersistentTags } from '~/tags/rejoin.ts';
import { ensureTagsSchema, insertTag, listTagsByUser } from '~/tags/storage.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function tagConnection(userId: string): RuntimeConnection {
  return {
    id: 'c-1',
    userId,
    tags: { ephemeral: new Map(), persistent: new Map() },
  } as unknown as RuntimeConnection;
}

describe('restorePersistentTags', () => {
  it('deletes a stored tag whose value no longer matches its group schema', () => {
    const sql = createTestSql();
    ensureTagsSchema(sql);
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'not-a-role!' });

    const connection = tagConnection('u-1');
    const errors: unknown[] = [];

    restorePersistentTags({
      sql,
      tagMembers: new Map(),
      connection,
      getSchema: () => v.picklist(['admin', 'editor']) as never,
      logger: { error: () => errors.push(1) },
    });

    const remaining = listTagsByUser(sql, 'u-1').map((t) => t.key);
    expect(remaining).toEqual(['admin']);
    expect(connection.tags.persistent.get('role')?.has('admin')).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('propagates a config error (async schema) and keeps the stored tag', () => {
    const sql = createTestSql();
    ensureTagsSchema(sql);
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    const connection = tagConnection('u-1');
    // An async validator is a config error, not invalid stored data.
    const asyncSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => Promise.resolve({ value: 'admin' }),
      },
    } as never;

    expect(() =>
      restorePersistentTags({
        sql,
        tagMembers: new Map(),
        connection,
        getSchema: () => asyncSchema,
        logger: { error: () => {} },
      }),
    ).toThrow(LiveThingConfigError);

    // The valid row must survive a config error, not be silently deleted.
    expect(listTagsByUser(sql, 'u-1').map((t) => t.key)).toEqual(['admin']);
  });

  it('restores a declared group that has a schema', () => {
    const sql = createTestSql();
    ensureTagsSchema(sql);
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    const connection = tagConnection('u-1');

    restorePersistentTags({
      sql,
      tagMembers: new Map(),
      connection,
      isGroupDeclared: () => true,
      getSchema: () => v.picklist(['admin', 'editor']) as never,
    });

    expect(listTagsByUser(sql, 'u-1').map((t) => t.key)).toEqual(['admin']);
    expect(connection.tags.persistent.get('role')?.has('admin')).toBe(true);
  });

  it('restores a declared group that has no schema', () => {
    const sql = createTestSql();
    ensureTagsSchema(sql);
    insertTag(sql, { userId: 'u-1', group: 'plan', key: 'pro' });
    const connection = tagConnection('u-1');

    restorePersistentTags({
      sql,
      tagMembers: new Map(),
      connection,
      isGroupDeclared: () => true,
      getSchema: () => undefined,
    });

    expect(listTagsByUser(sql, 'u-1').map((t) => t.key)).toEqual(['pro']);
    expect(connection.tags.persistent.get('plan')?.has('pro')).toBe(true);
  });

  it('drops and deletes a stored tag whose group is no longer declared', () => {
    const sql = createTestSql();
    ensureTagsSchema(sql);
    insertTag(sql, { userId: 'u-1', group: 'removed-plan', key: 'gold' });
    const connection = tagConnection('u-1');
    const errors: unknown[] = [];

    restorePersistentTags({
      sql,
      tagMembers: new Map(),
      connection,
      isGroupDeclared: () => false,
      getSchema: () => undefined,
      logger: { error: () => errors.push(1) },
    });

    expect(listTagsByUser(sql, 'u-1')).toEqual([]);
    expect(connection.tags.persistent.get('removed-plan')).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('no-ops for a connection with no user id, without querying storage', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensureTagsSchema(sql);
    statements = 0;

    const connection = tagConnection('');
    expect(() => restorePersistentTags({ sql, tagMembers: new Map(), connection })).not.toThrow();
    expect(connection.tags.persistent.size).toBe(0);
    expect(statements).toBe(0);
  });
});
