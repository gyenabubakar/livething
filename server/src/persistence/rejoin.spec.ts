import { autoRejoinIdentity } from '~/persistence/rejoin.ts';
import {
  ensurePersistenceSchema,
  insertMembership,
  listMembershipsByIdentity,
} from '~/persistence/storage.ts';
import { describe, expect, it, vi } from 'vitest';
import type { SQLProvider, SqlResult } from '~/context.ts';

function inMemorySql(): SQLProvider {
  type Row = {
    identity: string;
    channel_name: string;
    channel_scope: string;
    joined_at: number;
  };
  const rows = new Map<string, Row>();
  function key(r: { identity: string; channel_name: string; channel_scope: string }) {
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
    if (q.startsWith('INSERT OR REPLACE INTO _wskit_channel_memberships')) {
      const [identity, channel_name, channel_scope, joined_at] = params as [
        string,
        string,
        string,
        number,
      ];
      const row = { identity, channel_name, channel_scope, joined_at };
      rows.set(key(row), row);
      return result<TRow>([]);
    }
    if (
      q.startsWith(
        'DELETE FROM _wskit_channel_memberships WHERE identity = ? AND channel_name = ? AND channel_scope = ?',
      )
    ) {
      const [identity, channel_name, channel_scope] = params as [string, string, string];
      rows.delete(key({ identity, channel_name, channel_scope }));
      return result<TRow>([]);
    }
    if (q.startsWith('SELECT channel_name, channel_scope, joined_at')) {
      const [identity] = params as [string];
      return result<TRow>(
        [...rows.values()].filter((r) => r.identity === identity) as unknown as TRow[],
      );
    }
    if (q.startsWith('DELETE FROM _wskit_tags')) return result<TRow>([]);
    throw new Error(`unrecognized SQL: ${q}`);
  }
  return { exec } as unknown as SQLProvider;
}

function fakeConnection(identity: string) {
  return { id: 'c-1', identity } as never;
}

describe('autoRejoinIdentity', () => {
  it('no-ops when identity is empty', async () => {
    const sql = inMemorySql();
    ensurePersistenceSchema(sql);
    const subscribe = vi.fn<
      (
        connection: never,
        channelName: string,
        channelScope: string | null,
        payload: unknown,
        rejoining: boolean,
      ) => Promise<void>
    >(async () => {});
    const sendProtocolMessage = vi.fn();

    await autoRejoinIdentity(
      { sql, subscribeConnectionAsServer: subscribe, sendProtocolMessage },
      fakeConnection(''),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('no-ops when identity has no stored memberships', async () => {
    const sql = inMemorySql();
    ensurePersistenceSchema(sql);
    const subscribe = vi.fn<
      (
        connection: never,
        channelName: string,
        channelScope: string | null,
        payload: unknown,
        rejoining: boolean,
      ) => Promise<void>
    >(async () => {});

    await autoRejoinIdentity(
      {
        sql,
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: () => {},
      },
      fakeConnection('u-42'),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('calls subscribeConnectionAsServer for every stored membership', async () => {
    const sql = inMemorySql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, 'u-42', 'lobby', null);
    insertMembership(sql, 'u-42', 'room', 'room:abc');
    const subscribe = vi.fn<
      (
        connection: never,
        channelName: string,
        channelScope: string | null,
        payload: unknown,
        rejoining: boolean,
      ) => Promise<void>
    >(async () => {});

    await autoRejoinIdentity(
      {
        sql,
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: () => {},
      },
      fakeConnection('u-42'),
    );
    expect(subscribe).toHaveBeenCalledTimes(2);
    const calls = subscribe.mock.calls.map((c) => ({ name: c[1], scope: c[2] }));
    expect(calls).toContainEqual({ name: 'lobby', scope: null });
    expect(calls).toContainEqual({ name: 'room', scope: 'room:abc' });
  });

  it('on subscribe rejection drops the durable row and sends scoped _error', async () => {
    const sql = inMemorySql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, 'u-42', 'team-eng', null);

    const subscribe = vi.fn(async () => {
      throw new Error('not on the eng team');
    });
    const sent: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await autoRejoinIdentity(
      {
        sql,
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: (_c, event, payload) => sent.push({ event, payload }),
      },
      fakeConnection('u-42'),
    );

    expect(listMembershipsByIdentity(sql, 'u-42')).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe('_error');
    expect(sent[0]!.payload._channel).toBe('team-eng');
    expect(sent[0]!.payload.code).toBe('rejoin-rejected');
  });

  it('one rejection does not stop the rest of the rejoin', async () => {
    const sql = inMemorySql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, 'u-42', 'room-1', null);
    insertMembership(sql, 'u-42', 'room-2', null);
    insertMembership(sql, 'u-42', 'room-3', null);

    let nth = 0;
    const subscribe = vi.fn(async () => {
      nth++;
      if (nth === 2) throw new Error('gate-rejected on room-2');
    });

    await autoRejoinIdentity(
      {
        sql,
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: () => {},
      },
      fakeConnection('u-42'),
    );

    expect(subscribe).toHaveBeenCalledTimes(3);
    const remaining = listMembershipsByIdentity(sql, 'u-42').map((r) => r.channelName);
    expect(remaining.sort()).toEqual(['room-1', 'room-3']);
  });
});
