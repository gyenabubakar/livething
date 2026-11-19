import { createTestSql } from '~/_test/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SQLProvider } from '~/context.ts';
import {
  buildConnectionRow,
  deleteConnectionRow,
  ensureConnectionSchema,
  readConnectionRow,
  reconcileConnectionRows,
  writeConnectionRow,
} from './connection-store.ts';
import type { RuntimeConnection } from './types.ts';

function fakeConnection(overrides: Partial<RuntimeConnection> = {}): RuntimeConnection {
  return {
    id: 'conn_1',
    userId: 'user-1',
    socketKey: Symbol('ws'),
    descriptor: {
      send() {},
      close() {},
      bufferedAmount: () => 0,
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
      ['room:a::rooms', { channelName: 'room:a', channelFamily: 'rooms' }],
      ['lobby::', { channelName: 'lobby', channelFamily: null }],
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
    sql = createTestSql();
    ensureConnectionSchema(sql);
  });

  it('buildConnectionRow snapshots the in-memory connection', () => {
    const row = buildConnectionRow(fakeConnection());
    expect(row).toEqual({
      connection_id: 'conn_1',
      user_id: 'user-1',
      meta: { role: 'admin' },
      ephemeral_tags: [
        { group: 'role', key: 'admin' },
        { group: 'tier', key: 'free' },
      ],
      ephemeral_memberships: [
        { channelName: 'room:a', channelFamily: 'rooms' },
        { channelName: 'lobby', channelFamily: null },
      ],
      active_stream_ids: ['stream_1', 'stream_2'],
      awareness: {},
      metadata: {},
    });
  });

  it('writes and reads the full row, parsing JSON columns', () => {
    const viewing = { state: '{"viewingMessageId":"m1"}', meta: '{"role":"admin"}', updatedAt: 7 };
    writeConnectionRow(sql, buildConnectionRow(fakeConnection(), { 'room:a': viewing }));
    const read = readConnectionRow(sql, 'conn_1');
    expect(read).toEqual({
      connection_id: 'conn_1',
      user_id: 'user-1',
      meta: { role: 'admin' },
      ephemeral_tags: [
        { group: 'role', key: 'admin' },
        { group: 'tier', key: 'free' },
      ],
      ephemeral_memberships: [
        { channelName: 'room:a', channelFamily: 'rooms' },
        { channelName: 'lobby', channelFamily: null },
      ],
      active_stream_ids: ['stream_1', 'stream_2'],
      awareness: { 'room:a': viewing },
      metadata: {},
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
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'a', userId: 'a' })));
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'b', userId: 'b' })));

    reconcileConnectionRows(sql, new Set());

    expect(readConnectionRow(sql, 'a')).toBeNull();
    expect(readConnectionRow(sql, 'b')).toBeNull();
  });

  it('reconcile with surviving ids keeps those rows and drops the rest', () => {
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'a', userId: 'a' })));
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'b', userId: 'b' })));
    writeConnectionRow(sql, buildConnectionRow(fakeConnection({ id: 'c', userId: 'c' })));

    reconcileConnectionRows(sql, new Set(['a', 'c']));

    expect(readConnectionRow(sql, 'a')?.user_id).toBe('a');
    expect(readConnectionRow(sql, 'b')).toBeNull();
    expect(readConnectionRow(sql, 'c')?.user_id).toBe('c');
  });

  it('readConnectionRow returns empty defaults for malformed JSON columns', () => {
    // Defensive: a row written by an older build could end up with garbage in
    // the JSON columns. The reader recovers to empty defaults instead of
    // throwing — the connection wakes with no tags / no memberships rather
    // than crashing the engine.
    sql.exec(
      'INSERT OR REPLACE INTO __livething_connections (connection_id, user_id, meta, ephemeral_tags, ephemeral_memberships, active_stream_ids) VALUES (?, ?, ?, ?, ?, ?)',
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

  describe('reconcile batching (bound-parameter cap)', () => {
    function seededSql(rowCount: number) {
      const batchedSql = createTestSql({ limits: { maxBoundParams: 4 } });
      ensureConnectionSchema(batchedSql);
      for (let i = 0; i < rowCount; i++) {
        writeConnectionRow(
          batchedSql,
          buildConnectionRow(fakeConnection({ id: `conn_${i}`, userId: `user_${i}` })),
        );
      }

      return batchedSql;
    }

    it('deletes orphans spread across several delete batches, below the cap', () => {
      // 3 stored rows, cap of 4 params per statement — a single delete batch
      // covers every orphan without hitting the boundary logic at all.
      const batchedSql = seededSql(3);
      const surviving = new Set(['conn_0']);

      reconcileConnectionRows(batchedSql, surviving);

      expect(readConnectionRow(batchedSql, 'conn_0')).not.toBeNull();
      expect(readConnectionRow(batchedSql, 'conn_1')).toBeNull();
      expect(readConnectionRow(batchedSql, 'conn_2')).toBeNull();
    });

    it('deletes orphans exactly at the batch boundary', () => {
      // 4 stored rows, cap of 4 params per statement — the orphan set lands
      // exactly on one full batch.
      const batchedSql = seededSql(5);
      const surviving = new Set(['conn_0']);

      reconcileConnectionRows(batchedSql, surviving);

      expect(readConnectionRow(batchedSql, 'conn_0')).not.toBeNull();
      for (let i = 1; i < 5; i++) {
        expect(readConnectionRow(batchedSql, `conn_${i}`)).toBeNull();
      }
    });

    it('keeps survivors that are interleaved with orphans across multiple delete batches', () => {
      // 10 stored rows, cap of 4 params — orphan deletes need three batches
      // (4 + 4 + 2). Survivors are interleaved throughout, not clustered at
      // one end, so a batching bug that drops or duplicates ids across the
      // boundary would show up as a wrongly-deleted survivor or a
      // still-present orphan.
      const batchedSql = seededSql(10);
      const surviving = new Set(['conn_1', 'conn_4', 'conn_5', 'conn_8']);

      reconcileConnectionRows(batchedSql, surviving);

      for (let i = 0; i < 10; i++) {
        const row = readConnectionRow(batchedSql, `conn_${i}`);
        if (surviving.has(`conn_${i}`)) {
          expect(row?.user_id).toBe(`user_${i}`);
        } else {
          expect(row).toBeNull();
        }
      }
    });

    it('wipes the whole table on an empty surviving set, above the cap, with no bound-parameter error', () => {
      const batchedSql = seededSql(9);

      expect(() => reconcileConnectionRows(batchedSql, new Set())).not.toThrow();
      for (let i = 0; i < 9; i++) {
        expect(readConnectionRow(batchedSql, `conn_${i}`)).toBeNull();
      }
    });

    it('does not throw when every row survives, well above the cap', () => {
      // Every id is in the surviving set — no delete statement should run at
      // all, and reading all stored ids up front must not itself bind a
      // per-row parameter (it is a plain, unparameterised SELECT).
      const batchedSql = seededSql(9);
      const surviving = new Set(Array.from({ length: 9 }, (_, i) => `conn_${i}`));

      expect(() => reconcileConnectionRows(batchedSql, surviving)).not.toThrow();
      for (let i = 0; i < 9; i++) {
        expect(readConnectionRow(batchedSql, `conn_${i}`)?.user_id).toBe(`user_${i}`);
      }
    });
  });
});
