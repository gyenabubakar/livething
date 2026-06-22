import { reconcilePersistenceOnBoot } from '~/persistence/cleanup.ts';
import {
  ensurePersistenceSchema,
  insertMembership,
  listMembershipsByIdentity,
} from '~/persistence/storage.ts';
import { describe, expect, it } from 'vitest';
import type { SQLProvider, SqlResult } from '~/context.ts';

function inMemorySql(): SQLProvider {
  type Row = { identity: string; channel_name: string; channel_family: string; joined_at: number };
  const rows = new Map<string, Row>();
  function key(r: { identity: string; channel_name: string; channel_family: string }) {
    return `${r.identity}|${r.channel_name}|${r.channel_family}`;
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
      const [identity, channel_name, channel_family, joined_at] = params as [
        string,
        string,
        string,
        number,
      ];
      const row = { identity, channel_name, channel_family, joined_at };
      rows.set(key(row), row);
      return result<TRow>([]);
    }
    if (
      q.startsWith(
        'DELETE FROM __wskit_channel_memberships WHERE channel_name = ? AND channel_family = ?',
      )
    ) {
      const [channel_name, channel_family] = params as [string, string];
      for (const [k, row] of rows) {
        if (row.channel_name === channel_name && row.channel_family === channel_family) {
          rows.delete(k);
        }
      }
      return result<TRow>([]);
    }
    if (q.startsWith('SELECT DISTINCT channel_name, channel_family')) {
      const seen = new Set<string>();
      const out: { channel_name: string; channel_family: string }[] = [];
      for (const row of rows.values()) {
        const k = `${row.channel_name}|${row.channel_family}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ channel_name: row.channel_name, channel_family: row.channel_family });
      }
      return result<TRow>(out as unknown as TRow[]);
    }
    if (q.startsWith('SELECT channel_name, channel_family, joined_at')) {
      const [identity] = params as [string];
      return result<TRow>(
        [...rows.values()].filter((r) => r.identity === identity) as unknown as TRow[],
      );
    }
    throw new Error(`unrecognized SQL: ${q}`);
  }
  return { exec } as unknown as SQLProvider;
}

describe('reconcilePersistenceOnBoot', () => {
  it('drops rows for channels that no longer match a persistent channel', () => {
    const sql = inMemorySql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, { identity: 'u-1', channelName: 'team-eng', channelFamily: null });
    insertMembership(sql, { identity: 'u-2', channelName: 'team-eng', channelFamily: null });
    insertMembership(sql, { identity: 'u-1', channelName: 'archived-room', channelFamily: null });

    const dropped = reconcilePersistenceOnBoot(sql, (name) => name === 'team-eng');
    expect(dropped).toBe(1);
    expect(
      listMembershipsByIdentity(sql, 'u-1')
        .map((r) => r.channelName)
        .sort(),
    ).toEqual(['team-eng']);
    expect(
      listMembershipsByIdentity(sql, 'u-2')
        .map((r) => r.channelName)
        .sort(),
    ).toEqual(['team-eng']);
  });

  it('keeps rows for dynamic families that are still persistent', () => {
    const sql = inMemorySql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, { identity: 'u-1', channelName: 'room:abc', channelFamily: 'rooms' });
    insertMembership(sql, { identity: 'u-1', channelName: 'room:xyz', channelFamily: 'rooms' });

    const dropped = reconcilePersistenceOnBoot(sql, (_name, scope) => scope === 'rooms');
    expect(dropped).toBe(0);
    expect(listMembershipsByIdentity(sql, 'u-1')).toHaveLength(2);
  });

  it('returns 0 when the table is empty', () => {
    const sql = inMemorySql();
    ensurePersistenceSchema(sql);
    expect(reconcilePersistenceOnBoot(sql, () => true)).toBe(0);
  });
});
