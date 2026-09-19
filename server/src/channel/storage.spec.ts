import { createTestSql } from '~/_test/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SQLProvider } from '~/context.ts';
import {
  deleteMembership,
  deleteMembershipsByChannel,
  ensureMembershipSchema,
  insertMembership,
  listMembershipsByUser,
  purgeMembershipsByUser,
} from './storage.ts';

describe('channel membership storage', () => {
  let sql: SQLProvider;

  beforeEach(() => {
    sql = createTestSql();
    ensureMembershipSchema(sql);
  });

  it('maps null scope to "" on write and back to null on read', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null }, 1000);
    const rows = listMembershipsByUser(sql, 'u-1');
    expect(rows).toEqual([{ channelName: 'lobby', channelFamily: null, joinedAt: 1000 }]);
  });

  it('preserves non-null scope for dynamic family channels', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:42' }, 2000);
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:99' }, 3000);
    const rows = listMembershipsByUser(sql, 'u-1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channelFamily).sort()).toEqual(['room:42', 'room:99']);
  });

  it('INSERT OR REPLACE deduplicates on PK', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null }, 1000);
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null }, 5000);
    const rows = listMembershipsByUser(sql, 'u-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.joinedAt).toBe(5000);
  });

  it('deletes one membership for a specific user+channel+scope', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null }, 1000);
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:42' }, 2000);
    deleteMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    const rows = listMembershipsByUser(sql, 'u-1');
    expect(rows.map((r) => r.channelName)).toEqual(['room']);
  });

  it('listMembershipsByUser returns only rows for that user', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null }, 1000);
    insertMembership(sql, { userId: 'u-2', channelName: 'lobby', channelFamily: null }, 2000);
    insertMembership(sql, { userId: 'u-2', channelName: 'admin', channelFamily: null }, 3000);
    expect(listMembershipsByUser(sql, 'u-1')).toHaveLength(1);
    expect(listMembershipsByUser(sql, 'u-2')).toHaveLength(2);

    expect(listMembershipsByUser(sql, 'unknown')).toHaveLength(0);
  });

  it('purgeMembershipsByUser drops every row for that user', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null }, 1000);
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:42' }, 2000);
    insertMembership(sql, { userId: 'u-2', channelName: 'lobby', channelFamily: null }, 3000);
    purgeMembershipsByUser(sql, 'u-1');
    expect(listMembershipsByUser(sql, 'u-1')).toHaveLength(0);

    expect(listMembershipsByUser(sql, 'u-2')).toHaveLength(1);
  });

  it('deleteMembershipsByChannel removes rows across every user', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null }, 1000);
    insertMembership(sql, { userId: 'u-2', channelName: 'lobby', channelFamily: null }, 2000);
    insertMembership(sql, { userId: 'u-3', channelName: 'lobby', channelFamily: null }, 3000);
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:42' }, 4000);
    deleteMembershipsByChannel(sql, 'lobby', null);

    expect(listMembershipsByUser(sql, 'u-1').map((r) => r.channelName)).toEqual(['room']);
    expect(listMembershipsByUser(sql, 'u-2')).toHaveLength(0);
    expect(listMembershipsByUser(sql, 'u-3')).toHaveLength(0);
  });

  it('creates the table and both indexes', () => {
    const created = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
      .toArray()
      .map((row) => row.name);
    expect(created).toContain('__livething_channel_memberships');
    expect(created).toContain('__livething_idx_channel_memberships_user');
    expect(created).toContain('__livething_idx_channel_memberships_channel');
  });
});
