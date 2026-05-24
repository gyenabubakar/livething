import { beforeEach, describe, expect, it } from 'vitest';
import type { SQLProvider, SqlResult } from '~/context.ts';
import {
  buildConnectionRow,
  deleteConnectionRow,
  ensureConnectionSchema,
  readConnectionRow,
  reconcileConnectionRows,
  writeConnectionRow,
} from './connection-store.ts';
import type { RuntimeConnection } from './types.ts';

/**
 * Tiny in-memory SQL stub that recognises just the statements this file
 * emits. Returns plain objects through `SqlResult` — enough to drive the
 * helpers under test without spinning up a real SQLite instance.
 */
function inMemorySql(): SQLProvider {
  const rows = new Map<string, Record<string, unknown>>();

  function result<T>(items: T[]): SqlResult<T> {
    return {
      toArray: () => items.slice(),
      one: () => {
        if (items.length === 0) return null;
        if (items.length > 1) throw new Error('.one() called on multi-row result');
        return items[0]!;
      },
      raw: () => items.map((it) => Object.values(it as Record<string, unknown>)),
    };
  }

  function exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
    const normalized = query.trim().replace(/\s+/g, ' ');

    if (normalized.startsWith('CREATE')) return result<TRow>([]);

    if (normalized.startsWith('INSERT OR REPLACE INTO __wskit_connections')) {
      const [
        connection_id,
        identity,
        meta,
        ephemeral_tags,
        ephemeral_memberships,
        active_stream_ids,
      ] = params as string[];
      rows.set(connection_id!, {
        connection_id,
        identity,
        meta,
        ephemeral_tags,
        ephemeral_memberships,
        active_stream_ids,
      });
      return result<TRow>([]);
    }

    if (normalized.startsWith('SELECT connection_id')) {
      const id = params[0] as string;
      const row = rows.get(id);
      return result<TRow>(row ? [row as unknown as TRow] : []);
    }

    if (normalized.startsWith('DELETE FROM __wskit_connections WHERE connection_id =')) {
      rows.delete(params[0] as string);
      return result<TRow>([]);
    }

    if (normalized === 'DELETE FROM __wskit_connections') {
      rows.clear();
      return result<TRow>([]);
    }

    if (normalized.startsWith('DELETE FROM __wskit_connections WHERE connection_id NOT IN')) {
      const keep = new Set(params as string[]);
      for (const id of [...rows.keys()]) {
        if (!keep.has(id)) rows.delete(id);
      }
      return result<TRow>([]);
    }

    throw new Error(`unexpected query: ${normalized}`);
  }

  return { exec, transaction: <T>(fn: (tx: { exec: typeof exec }) => T) => fn({ exec }) };
}

function fakeConnection(overrides: Partial<RuntimeConnection> = {}): RuntimeConnection {
  return {
    id: 'conn_1',
    identity: 'user-1',
    wsKey: Symbol('ws'),
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount: () => 0,
      identity: 'user-1',
    },
    meta: { role: 'admin' },
    tags: {
      ephemeral: new Map<string, Set<string>>([
        ['role', new Set(['admin'])],
        ['tier', new Set(['free'])],
      ]),
      persistent: new Map<string, Set<string>>(),
    },
    channelMemberships: new Map([
      ['room:a::rooms', { channelName: 'room:a', channelScope: 'rooms' }],
      ['lobby::', { channelName: 'lobby', channelScope: null }],
    ]),
    latency: null,
    quality: 'good',
    activeStreamIds: new Set(['stream_1', 'stream_2']),
    ...overrides,
  };
}

describe('connection-store', () => {
  let sql: SQLProvider;

  beforeEach(() => {
    sql = inMemorySql();
    ensureConnectionSchema(sql);
  });

  it('buildConnectionRow snapshots the in-memory connection', () => {
    const row = buildConnectionRow(fakeConnection());
    expect(row).toEqual({
      connection_id: 'conn_1',
      identity: 'user-1',
      meta: { role: 'admin' },
      ephemeral_tags: [
        { group: 'role', key: 'admin' },
        { group: 'tier', key: 'free' },
      ],
      ephemeral_memberships: [
        { channelName: 'room:a', channelScope: 'rooms' },
        { channelName: 'lobby', channelScope: null },
      ],
      active_stream_ids: ['stream_1', 'stream_2'],
    });
  });

  it('writes and reads the full row, parsing JSON columns', () => {
    writeConnectionRow(sql, buildConnectionRow(fakeConnection()));
    const read = readConnectionRow(sql, 'conn_1');
    expect(read).toEqual({
      connection_id: 'conn_1',
      identity: 'user-1',
      meta: { role: 'admin' },
      ephemeral_tags: [
        { group: 'role', key: 'admin' },
        { group: 'tier', key: 'free' },
      ],
      ephemeral_memberships: [
        { channelName: 'room:a', channelScope: 'rooms' },
        { channelName: 'lobby', channelScope: null },
      ],
      active_stream_ids: ['stream_1', 'stream_2'],
    });
  });

  it('returns null when reading a row that does not exist', () => {
    expect(readConnectionRow(sql, 'missing')).toBeNull();
  });

  it('overwrites the row on a second write (INSERT OR REPLACE)', () => {
    writeConnectionRow(sql, buildConnectionRow(fakeConnection()));
    writeConnectionRow(
      sql,
      buildConnectionRow(
        fakeConnection({
          tags: {
            ephemeral: new Map<string, Set<string>>([['role', new Set(['guest'])]]),
            persistent: new Map<string, Set<string>>(),
          },
          activeStreamIds: new Set(),
        }),
      ),
    );
    const row = readConnectionRow(sql, 'conn_1');
    expect(row?.ephemeral_tags).toEqual([{ group: 'role', key: 'guest' }]);
    expect(row?.active_stream_ids).toEqual([]);
  });

  it('delete removes the row by connection_id', () => {
    writeConnectionRow(sql, buildConnectionRow(fakeConnection()));
    deleteConnectionRow(sql, 'conn_1');
    expect(readConnectionRow(sql, 'conn_1')).toBeNull();
  });

  it('reconcile with empty set wipes the table', () => {
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'a', identity: 'a' })));
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'b', identity: 'b' })));

    reconcileConnectionRows(sql, new Set());

    expect(readConnectionRow(sql, 'a')).toBeNull();
    expect(readConnectionRow(sql, 'b')).toBeNull();
  });

  it('reconcile with surviving ids keeps those rows and drops the rest', () => {
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'a', identity: 'a' })));
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'b', identity: 'b' })));
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'c', identity: 'c' })));

    reconcileConnectionRows(sql, new Set(['a', 'c']));

    expect(readConnectionRow(sql, 'a')?.identity).toBe('a');
    expect(readConnectionRow(sql, 'b')).toBeNull();
    expect(readConnectionRow(sql, 'c')?.identity).toBe('c');
  });

  it('readConnectionRow returns empty defaults for malformed JSON columns', () => {
    // Defensive: a row written by an older build could end up with garbage in
    // the JSON columns. The reader recovers to empty defaults instead of
    // throwing — the connection wakes with no tags / no memberships rather
    // than crashing the engine.
    sql.exec(
      'INSERT OR REPLACE INTO __wskit_connections (connection_id, identity, meta, ephemeral_tags, ephemeral_memberships, active_stream_ids) VALUES (?, ?, ?, ?, ?, ?)',
      'broken',
      'broken-id',
      'not-json',
      'still-not-json',
      'still-not-json',
      'still-not-json',
    );
    const row = readConnectionRow(sql, 'broken');
    expect(row?.meta).toEqual({});
    expect(row?.ephemeral_tags).toEqual([]);
    expect(row?.ephemeral_memberships).toEqual([]);
    expect(row?.active_stream_ids).toEqual([]);
  });
});
