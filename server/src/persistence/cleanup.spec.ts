import { createTestSql } from '~/_test/sql.ts';
import { reconcilePersistenceOnBoot } from '~/persistence/cleanup.ts';
import {
  ensurePersistenceSchema,
  insertMembership,
  listMembershipsByUser,
} from '~/persistence/storage.ts';
import { describe, expect, it } from 'vitest';

describe('reconcilePersistenceOnBoot', () => {
  it('drops rows for channels that no longer match a persistent channel', () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, { userId: 'u-1', channelName: 'team-eng', channelFamily: null });
    insertMembership(sql, { userId: 'u-2', channelName: 'team-eng', channelFamily: null });
    insertMembership(sql, { userId: 'u-1', channelName: 'archived-room', channelFamily: null });

    const dropped = reconcilePersistenceOnBoot(sql, (name) => name === 'team-eng');
    expect(dropped).toBe(1);
    expect(
      listMembershipsByUser(sql, 'u-1')
        .map((r) => r.channelName)
        .sort(),
    ).toEqual(['team-eng']);
    expect(
      listMembershipsByUser(sql, 'u-2')
        .map((r) => r.channelName)
        .sort(),
    ).toEqual(['team-eng']);
  });

  it('keeps rows for dynamic families that are still persistent', () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, { userId: 'u-1', channelName: 'room:abc', channelFamily: 'rooms' });
    insertMembership(sql, { userId: 'u-1', channelName: 'room:xyz', channelFamily: 'rooms' });

    const dropped = reconcilePersistenceOnBoot(sql, (_name, scope) => scope === 'rooms');
    expect(dropped).toBe(0);
    expect(listMembershipsByUser(sql, 'u-1')).toHaveLength(2);
  });

  it('returns 0 when the table is empty', () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
    expect(reconcilePersistenceOnBoot(sql, () => true)).toBe(0);
  });
});
