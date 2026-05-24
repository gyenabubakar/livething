import { beforeEach, describe, expect, it } from 'vitest';
import type { SQLProvider, SqlResult } from '~/context.ts';
import {
  deleteMembership,
  deleteMembershipsByChannel,
  ensurePersistenceSchema,
  insertMembership,
  listMembershipsByIdentity,
  purgeMembershipsByIdentity,
  purgeTagsByIdentity,
} from './storage.ts';

/**
 * Tiny SQL stub that recognises just the statements this file emits. Keeps
 * membership and tag rows in two maps so the helpers can be exercised
 * end-to-end without a real SQLite instance.
 */
function inMemorySql(): SQLProvider {
  type MembershipRow = {
    identity: string;
    channel_name: string;
    channel_scope: string;
    joined_at: number;
  };
  type TagRow = { identity: string; group_name: string; key: string; added_at: number };

  const memberships = new Map<string, MembershipRow>();
  const tags = new Map<string, TagRow>();

  function mKey(r: { identity: string; channel_name: string; channel_scope: string }) {
    return `${r.identity}|${r.channel_name}|${r.channel_scope}`;
  }
  function result<T>(items: T[]): SqlResult<T> {
    return {
      toArray: () => items.slice(),
      one: () => (items.length === 0 ? null : items[0]!),
      raw: () => items.map((it) => Object.values(it as Record<string, unknown>)),
    };
  }

  function exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
    const q = query.trim().replace(/\s+/g, ' ');

    if (q.startsWith('CREATE')) return result<TRow>([]);

    if (q.startsWith('INSERT OR REPLACE INTO __wskit_channel_memberships')) {
      const [identity, channel_name, channel_scope, joined_at] = params as [
        string,
        string,
        string,
        number,
      ];
      const row = { identity, channel_name, channel_scope, joined_at };
      memberships.set(mKey(row), row);
      return result<TRow>([]);
    }

    if (
      q.startsWith(
        'DELETE FROM __wskit_channel_memberships WHERE identity = ? AND channel_name = ? AND channel_scope = ?',
      )
    ) {
      const [identity, channel_name, channel_scope] = params as [string, string, string];
      memberships.delete(mKey({ identity, channel_name, channel_scope }));
      return result<TRow>([]);
    }

    if (
      q.startsWith(
        'DELETE FROM __wskit_channel_memberships WHERE channel_name = ? AND channel_scope = ?',
      )
    ) {
      const [channel_name, channel_scope] = params as [string, string];
      for (const [k, row] of memberships) {
        if (row.channel_name === channel_name && row.channel_scope === channel_scope) {
          memberships.delete(k);
        }
      }
      return result<TRow>([]);
    }

    if (q.startsWith('DELETE FROM __wskit_channel_memberships WHERE identity = ?')) {
      const [identity] = params as [string];
      for (const [k, row] of memberships) {
        if (row.identity === identity) memberships.delete(k);
      }
      return result<TRow>([]);
    }

    if (
      q.startsWith('SELECT channel_name, channel_scope, joined_at FROM __wskit_channel_memberships')
    ) {
      const [identity] = params as [string];
      const rows = [...memberships.values()].filter((r) => r.identity === identity);
      return result<TRow>(rows as unknown as TRow[]);
    }

    if (q.startsWith('DELETE FROM __wskit_tags WHERE identity = ?')) {
      const [identity] = params as [string];
      for (const [k, row] of tags) {
        if (row.identity === identity) tags.delete(k);
      }
      return result<TRow>([]);
    }

    throw new Error(`unrecognized SQL: ${q}`);
  }

  return { exec } as unknown as SQLProvider;
}

describe('persistence storage', () => {
  let sql: SQLProvider;

  beforeEach(() => {
    sql = inMemorySql();
    ensurePersistenceSchema(sql);
  });

  it('maps null scope to "" on write and back to null on read', () => {
    insertMembership(sql, { identity: 'u-1', channelName: 'lobby', channelScope: null }, 1000);
    const rows = listMembershipsByIdentity(sql, 'u-1');
    expect(rows).toEqual([{ channelName: 'lobby', channelScope: null, joinedAt: 1000 }]);
  });

  it('preserves non-null scope for dynamic family channels', () => {
    insertMembership(sql, { identity: 'u-1', channelName: 'room', channelScope: 'room:42' }, 2000);
    insertMembership(sql, { identity: 'u-1', channelName: 'room', channelScope: 'room:99' }, 3000);
    const rows = listMembershipsByIdentity(sql, 'u-1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channelScope).sort()).toEqual(['room:42', 'room:99']);
  });

  it('INSERT OR REPLACE deduplicates on PK', () => {
    insertMembership(sql, { identity: 'u-1', channelName: 'lobby', channelScope: null }, 1000);
    insertMembership(sql, { identity: 'u-1', channelName: 'lobby', channelScope: null }, 5000);
    const rows = listMembershipsByIdentity(sql, 'u-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.joinedAt).toBe(5000);
  });

  it('deletes one membership for a specific identity+channel+scope', () => {
    insertMembership(sql, { identity: 'u-1', channelName: 'lobby', channelScope: null }, 1000);
    insertMembership(sql, { identity: 'u-1', channelName: 'room', channelScope: 'room:42' }, 2000);
    deleteMembership(sql, { identity: 'u-1', channelName: 'lobby', channelScope: null });
    const rows = listMembershipsByIdentity(sql, 'u-1');
    expect(rows.map((r) => r.channelName)).toEqual(['room']);
  });

  it('listMembershipsByIdentity returns only rows for that identity', () => {
    insertMembership(sql, { identity: 'u-1', channelName: 'lobby', channelScope: null }, 1000);
    insertMembership(sql, { identity: 'u-2', channelName: 'lobby', channelScope: null }, 2000);
    insertMembership(sql, { identity: 'u-2', channelName: 'admin', channelScope: null }, 3000);
    expect(listMembershipsByIdentity(sql, 'u-1')).toHaveLength(1);
    expect(listMembershipsByIdentity(sql, 'u-2')).toHaveLength(2);
    expect(listMembershipsByIdentity(sql, 'unknown')).toHaveLength(0);
  });

  it('purgeMembershipsByIdentity drops every row for that identity', () => {
    insertMembership(sql, { identity: 'u-1', channelName: 'lobby', channelScope: null }, 1000);
    insertMembership(sql, { identity: 'u-1', channelName: 'room', channelScope: 'room:42' }, 2000);
    insertMembership(sql, { identity: 'u-2', channelName: 'lobby', channelScope: null }, 3000);
    purgeMembershipsByIdentity(sql, 'u-1');
    expect(listMembershipsByIdentity(sql, 'u-1')).toHaveLength(0);
    expect(listMembershipsByIdentity(sql, 'u-2')).toHaveLength(1);
  });

  it('deleteMembershipsByChannel removes rows across every identity', () => {
    insertMembership(sql, { identity: 'u-1', channelName: 'lobby', channelScope: null }, 1000);
    insertMembership(sql, { identity: 'u-2', channelName: 'lobby', channelScope: null }, 2000);
    insertMembership(sql, { identity: 'u-3', channelName: 'lobby', channelScope: null }, 3000);
    insertMembership(sql, { identity: 'u-1', channelName: 'room', channelScope: 'room:42' }, 4000);
    deleteMembershipsByChannel(sql, 'lobby', null);
    expect(listMembershipsByIdentity(sql, 'u-1').map((r) => r.channelName)).toEqual(['room']);
    expect(listMembershipsByIdentity(sql, 'u-2')).toHaveLength(0);
    expect(listMembershipsByIdentity(sql, 'u-3')).toHaveLength(0);
  });

  it('purgeTagsByIdentity is a no-op when the tag table is empty', () => {
    expect(() => purgeTagsByIdentity(sql, 'u-1')).not.toThrow();
  });
});
