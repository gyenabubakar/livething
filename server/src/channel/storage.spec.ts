import { createTestSql } from '~/_test/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SQLProvider } from '~/context.ts';
import {
  deleteMembership,
  deleteMembershipsByChannel,
  ensureMembershipSchema,
  insertMembership,
  listMembersByChannel,
  listMembershipsByUser,
  purgeMembershipsByUser,
  readMembership,
} from './storage.ts';

describe('channel membership storage', () => {
  let sql: SQLProvider;

  beforeEach(() => {
    sql = createTestSql();
    ensureMembershipSchema(sql);
  });

  it('maps null scope to "" on write and back to null on read', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    const rows = listMembershipsByUser(sql, 'u-1');
    expect(rows).toEqual([{ channelName: 'lobby', channelFamily: null }]);
  });

  it('preserves non-null scope for dynamic family channels', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:42' });
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:99' });
    const rows = listMembershipsByUser(sql, 'u-1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channelFamily).sort()).toEqual(['room:42', 'room:99']);
  });

  it('INSERT OR REPLACE deduplicates on PK', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    const rows = listMembershipsByUser(sql, 'u-1');
    expect(rows).toHaveLength(1);
  });

  it('deletes one membership for a specific user+channel+scope', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:42' });
    deleteMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    const rows = listMembershipsByUser(sql, 'u-1');
    expect(rows.map((r) => r.channelName)).toEqual(['room']);
  });

  it('listMembershipsByUser returns only rows for that user', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-2', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-2', channelName: 'admin', channelFamily: null });
    expect(listMembershipsByUser(sql, 'u-1')).toHaveLength(1);
    expect(listMembershipsByUser(sql, 'u-2')).toHaveLength(2);

    expect(listMembershipsByUser(sql, 'unknown')).toHaveLength(0);
  });

  it('purgeMembershipsByUser drops every row for that user', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:42' });
    insertMembership(sql, { userId: 'u-2', channelName: 'lobby', channelFamily: null });
    purgeMembershipsByUser(sql, 'u-1');
    expect(listMembershipsByUser(sql, 'u-1')).toHaveLength(0);

    expect(listMembershipsByUser(sql, 'u-2')).toHaveLength(1);
  });

  it('deleteMembershipsByChannel removes rows across every user', () => {
    insertMembership(sql, { userId: 'u-1', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-2', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-3', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-1', channelName: 'room', channelFamily: 'room:42' });
    deleteMembershipsByChannel(sql, 'lobby', null);

    expect(listMembershipsByUser(sql, 'u-1').map((r) => r.channelName)).toEqual(['room']);
    expect(listMembershipsByUser(sql, 'u-2')).toHaveLength(0);
    expect(listMembershipsByUser(sql, 'u-3')).toHaveLength(0);
  });

  it('stores the member meta and reads it back', () => {
    const key = { userId: 'u-1', channelName: 'room', channelFamily: 'rooms' };
    insertMembership(sql, { ...key, meta: { name: 'Ada' } });

    expect(readMembership(sql, key)).toEqual({ meta: { name: 'Ada' } });
    expect(readMembership(sql, { ...key, userId: 'u-2' })).toBeUndefined();
  });

  it('lists the members of one exact channel with their meta', () => {
    insertMembership(sql, {
      userId: 'u-1',
      channelName: 'room',
      channelFamily: 'a',
      meta: { n: 1 },
    });
    insertMembership(sql, { userId: 'u-2', channelName: 'room', channelFamily: 'a' });
    insertMembership(sql, { userId: 'u-3', channelName: 'room', channelFamily: 'b' });

    const members = listMembersByChannel(sql, 'room', 'a').sort((x, y) =>
      x.userId.localeCompare(y.userId),
    );
    expect(members).toEqual([
      { userId: 'u-1', meta: { n: 1 } },
      { userId: 'u-2', meta: {} },
    ]);
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
