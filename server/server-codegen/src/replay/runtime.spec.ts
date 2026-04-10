import { describe, expect, it, vi } from 'vitest';
import {
  buildReplayRow,
  ensureReplaySchema,
  loadReplayRows,
  matchesReplayScope,
  persistReplayMessage,
  pruneExpiredReplayRows,
  pruneReplayScopeRows,
  readReplayPayloadScope,
  shouldStoreReplayMessage,
  stripSnapshotMetadata,
} from './runtime.ts';
import type { ReplayRow } from './types.ts';

class FakeSqlResult {
  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  toArray(): Record<string, unknown>[] {
    return [...this.rows];
  }

  one(): Record<string, unknown> | null {
    return this.rows[0] ?? null;
  }

  raw(): unknown[][] {
    return this.rows.map((row) => Object.values(row));
  }
}

function createReplaySql() {
  const rows = new Map<string, ReplayRow>();
  const calls: { query: string; params: unknown[] }[] = [];

  const exec = (query: string, ...params: unknown[]) => {
    const normalized = query.replaceAll(/\s+/g, ' ').trim();
    calls.push({ query: normalized, params });

    if (normalized.startsWith('SELECT rowKey, messageId, seq, event, payload, namespace')) {
      if (normalized.includes('WHERE channel IS ?')) {
        const [channel, channelScope, since] = params;
        return new FakeSqlResult(
          [...rows.values()]
            .filter(
              (row) =>
                row.channel === ((channel as string | null) ?? null) &&
                row.channelScope === ((channelScope as string | null) ?? null) &&
                row.seq > Number(since),
            )
            .sort((a, b) => a.seq - b.seq)
            .map((row) => ({ ...row })),
        );
      }

      const [since] = params;
      return new FakeSqlResult(
        [...rows.values()]
          .filter(
            (row) =>
              row.namespace === null &&
              row.channel === null &&
              row.channelScope === null &&
              row.seq > Number(since),
          )
          .sort((a, b) => a.seq - b.seq)
          .map((row) => ({ ...row })),
      );
    }

    if (normalized.startsWith('SELECT rowKey, messageId, seq, event, payload')) {
      const row = rows.get(String(params[0]));
      return new FakeSqlResult(row ? [{ ...row }] : []);
    }

    if (normalized.startsWith('INSERT OR REPLACE INTO _wskit_replay')) {
      const [rowKey, messageId, seq, event, payload, namespace, channel, channelScope, snapshotKey, createdAt] =
        params;
      rows.set(String(rowKey), {
        rowKey: String(rowKey),
        messageId: String(messageId),
        seq: Number(seq),
        event: String(event),
        payload: String(payload),
        namespace: (namespace as string | null) ?? null,
        channel: (channel as string | null) ?? null,
        channelScope: (channelScope as string | null) ?? null,
        snapshotKey: (snapshotKey as string | null) ?? null,
        createdAt: Number(createdAt),
      });
      return new FakeSqlResult([]);
    }

    if (normalized.startsWith('DELETE FROM _wskit_replay WHERE rowKey = ?')) {
      rows.delete(String(params[0]));
      return new FakeSqlResult([]);
    }

    if (normalized.startsWith('DELETE FROM _wskit_replay WHERE createdAt < ?')) {
      const cutoff = Number(params[0]);
      for (const [key, row] of rows) {
        if (row.createdAt < cutoff) rows.delete(key);
      }
      return new FakeSqlResult([]);
    }

    if (normalized.startsWith('DELETE FROM _wskit_replay WHERE rowKey IN (')) {
      const [namespace, channel, channelScope, offset] = params;
      const doomed = [...rows.values()]
        .filter(
          (row) =>
            row.namespace === ((namespace as string | null) ?? null) &&
            row.channel === ((channel as string | null) ?? null) &&
            row.channelScope === ((channelScope as string | null) ?? null),
        )
        .sort((a, b) => b.seq - a.seq)
        .slice(Number(offset));
      for (const row of doomed) rows.delete(row.rowKey);
      return new FakeSqlResult([]);
    }

    return new FakeSqlResult([]);
  };

  return {
    rows,
    calls,
    sql: {
      exec,
      transaction<T>(fn: (tx: { exec: typeof exec }) => T): T {
        return fn({ exec });
      },
    },
  };
}

describe('replay/runtime', () => {
  it('creates the replay schema and indexes', () => {
    const exec = vi.fn(() => new FakeSqlResult([]));
    const sql = { exec };

    ensureReplaySchema(sql);

    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('matches replay ownership by scope and excludes mismatched messages', () => {
    expect(matchesReplayScope(undefined, {})).toBe(true);
    expect(matchesReplayScope(undefined, { channelName: 'room-1' })).toBe(false);
    expect(matchesReplayScope('rooms', { channelScope: 'rooms' })).toBe(true);
    expect(
      shouldStoreReplayMessage(
        'rooms',
        'message',
        { _channel: 'room-1', _channelScope: 'rooms' },
        new Set(['typing']),
      ),
    ).toBe(true);
    expect(
      shouldStoreReplayMessage(
        'rooms',
        'typing',
        { _channel: 'room-1', _channelScope: 'rooms' },
        new Set(['typing']),
      ),
    ).toBe(false);
  });

  it('builds replay rows from final wire payloads and strips metadata for reducers', () => {
    const payload = {
      text: 'hello',
      _seq: 7,
      _messageId: 'msg_1',
      _channel: 'room-1',
      _channelScope: 'rooms',
    };

    expect(readReplayPayloadScope(payload)).toEqual({
      namespace: null,
      channel: 'room-1',
      channelScope: 'rooms',
    });

    expect(
      buildReplayRow({ type: 'snapshot', snapshotKey: (_event, next) => String(next.text) }, 'message', payload, 99),
    ).toMatchObject({
      rowKey: 'snapshot||room-1|rooms|hello',
      messageId: 'msg_1',
      seq: 7,
      event: 'message',
      channel: 'room-1',
      channelScope: 'rooms',
      snapshotKey: 'hello',
      createdAt: 99,
    });

    expect(stripSnapshotMetadata(payload)).toEqual({ text: 'hello' });
  });

  it('persists history rows, supports snapshot reducers, and deletes snapshots on null', () => {
    const { rows, sql } = createReplaySql();

    const history = persistReplayMessage(
      sql,
      { type: 'history' },
      'message',
      { text: 'one', _seq: 1, _messageId: 'msg_1' },
      100,
    );

    expect(history?.rowKey).toBe('msg_1');
    expect(rows.get('msg_1')?.payload).toBe(JSON.stringify({ text: 'one', _seq: 1, _messageId: 'msg_1' }));

    persistReplayMessage(
      sql,
      {
        type: 'snapshot',
        snapshotKey: (_event, payload) => String(payload.id),
        reduce(previous, next) {
          return {
            event: 'doc-snapshot',
            payload: {
              id: next.payload.id,
              title: previous?.payload.title ?? '',
              content: next.payload.content ?? previous?.payload.content ?? '',
            },
          };
        },
      },
      'doc-content-set',
      { id: 'doc-1', content: 'hello', _seq: 2, _messageId: 'msg_2' },
      101,
    );

    const snapshot = rows.get('snapshot||||doc-1');
    expect(snapshot).toMatchObject({
      event: 'doc-snapshot',
      snapshotKey: 'doc-1',
    });
    expect(JSON.parse(snapshot?.payload ?? '{}')).toEqual({ id: 'doc-1', title: '', content: 'hello' });

    persistReplayMessage(
      sql,
      {
        type: 'snapshot',
        snapshotKey: (_event, payload) => String(payload.id),
        reduce() {
          return null;
        },
      },
      'doc-deleted',
      { id: 'doc-1', _seq: 3, _messageId: 'msg_3' },
      102,
    );

    expect(rows.has('snapshot||||doc-1')).toBe(false);
  });

  it('prunes retained rows and loads replay rows in sequence order', () => {
    const { rows, sql } = createReplaySql();

    rows.set('old', {
      rowKey: 'old',
      messageId: 'msg_old',
      seq: 1,
      event: 'message',
      payload: '{}',
      namespace: null,
      channel: null,
      channelScope: null,
      snapshotKey: null,
      createdAt: 10,
    });
    rows.set('new', {
      rowKey: 'new',
      messageId: 'msg_new',
      seq: 2,
      event: 'message',
      payload: '{}',
      namespace: null,
      channel: null,
      channelScope: null,
      snapshotKey: null,
      createdAt: 90,
    });
    rows.set('c1', {
      rowKey: 'c1',
      messageId: 'msg_c1',
      seq: 3,
      event: 'message',
      payload: '{}',
      namespace: null,
      channel: 'room-1',
      channelScope: 'rooms',
      snapshotKey: null,
      createdAt: 100,
    });
    rows.set('c2', {
      rowKey: 'c2',
      messageId: 'msg_c2',
      seq: 4,
      event: 'message',
      payload: '{}',
      namespace: null,
      channel: 'room-1',
      channelScope: 'rooms',
      snapshotKey: null,
      createdAt: 110,
    });
    rows.set('c3', {
      rowKey: 'c3',
      messageId: 'msg_c3',
      seq: 5,
      event: 'message',
      payload: '{}',
      namespace: null,
      channel: 'room-1',
      channelScope: 'rooms',
      snapshotKey: null,
      createdAt: 120,
    });

    pruneExpiredReplayRows(sql, { maxAgeMs: 20 }, 100);
    expect(rows.has('old')).toBe(false);

    pruneReplayScopeRows(sql, { maxMessages: 2 }, { namespace: null, channel: 'room-1', channelScope: 'rooms' });
    expect([...rows.keys()]).not.toContain('c1');

    expect(loadReplayRows(sql, 1, {} as { channelName?: string; channelScope?: string }).map((row) => row.seq)).toEqual([2]);
    expect(loadReplayRows(sql, 2, { channelName: 'room-1', channelScope: 'rooms' }).map((row) => row.seq)).toEqual([4, 5]);
  });
});
