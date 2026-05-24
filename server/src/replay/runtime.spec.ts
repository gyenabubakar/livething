import { ValidationFailed } from '@wskit/core';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import {
  assertReplayScopeServable,
  buildLoadReplayQuery,
  buildReplayRow,
  ensureReplaySchema,
  isChannelReplayAuthorized,
  loadReplayRows,
  matchesReplayScope,
  persistReplayMessage,
  pruneExpiredReplayRows,
  pruneReplayScopeRows,
  readReplayScope,
  shouldStoreReplayMessage,
} from './runtime.ts';
import type { ReplayRow } from './types.ts';

class FakeSqlResult<TRow = unknown> {
  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  toArray(): TRow[] {
    return [...this.rows] as TRow[];
  }

  one(): TRow | null {
    return (this.rows[0] as TRow | undefined) ?? null;
  }

  raw(): unknown[][] {
    return this.rows.map((row) => Object.values(row));
  }
}

function createReplaySql() {
  const rows = new Map<string, ReplayRow>();
  const calls: { query: string; params: unknown[] }[] = [];

  function exec<TRow = unknown>(query: string, ...params: unknown[]) {
    const normalized = query.replaceAll(/\s+/g, ' ').trim();
    calls.push({ query: normalized, params });

    if (normalized.startsWith('SELECT rowKey, messageId, seq, event, payload, namespace')) {
      if (
        normalized.includes('channelScope IS NULL') &&
        normalized.includes('WHERE channel IS ?')
      ) {
        const [channel, since] = params;
        return new FakeSqlResult<TRow>(
          [...rows.values()]
            .filter(
              (row) =>
                row.channel === ((channel as string | null) ?? null) &&
                row.channelScope === null &&
                row.seq > Number(since),
            )
            .sort((a, b) => a.seq - b.seq)
            .map((row) => ({ ...row })),
        );
      }
      if (normalized.includes('WHERE channel IS ?')) {
        const [channel, channelScope, since] = params;
        return new FakeSqlResult<TRow>(
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
      return new FakeSqlResult<TRow>(
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
      return new FakeSqlResult<TRow>(row ? [{ ...row }] : []);
    }

    if (normalized.startsWith('INSERT OR REPLACE INTO __wskit_replay')) {
      const [
        rowKey,
        messageId,
        seq,
        event,
        payload,
        namespace,
        channel,
        channelScope,
        snapshotKey,
        createdAt,
      ] = params;
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
      return new FakeSqlResult<TRow>([]);
    }

    if (normalized.startsWith('DELETE FROM __wskit_replay WHERE rowKey = ?')) {
      rows.delete(String(params[0]));
      return new FakeSqlResult<TRow>([]);
    }

    if (normalized.startsWith('DELETE FROM __wskit_replay WHERE createdAt < ?')) {
      const cutoff = Number(params[0]);
      for (const [key, row] of rows) {
        if (row.createdAt < cutoff) rows.delete(key);
      }
      return new FakeSqlResult<TRow>([]);
    }

    if (normalized.startsWith('DELETE FROM __wskit_replay WHERE rowKey IN (')) {
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
      return new FakeSqlResult<TRow>([]);
    }

    return new FakeSqlResult<TRow>([]);
  }

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
  it('creates the replay schema and indexes in one round trip', () => {
    const exec = vi.fn(() => new FakeSqlResult([]));
    const sql = { exec };

    ensureReplaySchema(sql);

    // Schema-init batches CREATE TABLE + CREATE INDEX into one multi-statement
    // string so the engine boot pays one round trip instead of three.
    expect(exec).toHaveBeenCalledTimes(1);
    const call = String((exec.mock.calls[0] as unknown as unknown[])?.[0] ?? '');
    expect(call).toContain('CREATE TABLE IF NOT EXISTS __wskit_replay');
    expect(call).toContain('CREATE INDEX IF NOT EXISTS __wskit_idx_replay_seq');
    expect(call).toContain('CREATE INDEX IF NOT EXISTS __wskit_idx_replay_scope_seq');
  });

  it('matches replay ownership by scope and excludes mismatched messages', () => {
    expect(matchesReplayScope(undefined, {})).toBe(true);
    // Server-level replay cascades into channels by default — the message
    // matches when the channel has not registered its own replay primitive.
    expect(matchesReplayScope(undefined, { channelName: 'room-1' })).toBe(true);
    // Once the channel claims its own replay, server-level steps aside.
    expect(matchesReplayScope(undefined, { channelName: 'room-1' }, new Set(['room-1']))).toBe(
      false,
    );
    expect(matchesReplayScope('rooms', { channelScope: 'rooms' })).toBe(true);
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: 'rooms',
        wskit: { channel: 'room-1', channelScope: 'rooms' },
        exclude: new Set(['typing']),
      }),
    ).toBe(true);
    expect(
      shouldStoreReplayMessage('typing', {
        channelKey: 'rooms',
        wskit: { channel: 'room-1', channelScope: 'rooms' },
        exclude: new Set(['typing']),
      }),
    ).toBe(false);
  });

  it('server-level shouldStoreReplayMessage cascades into channels not in the claimed set', () => {
    // No channel has claimed; server-level captures channel traffic.
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        wskit: { channel: 'room-1', channelScope: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(true);

    // 'rooms' is claimed (channel registered its own replay) — server-level skips.
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        wskit: { channel: 'room-1', channelScope: 'rooms' },
        exclude: new Set(),
        claimedChannelKeys: new Set(['rooms']),
      }),
    ).toBe(false);

    // Static channel claimed by name (no channelScope on the frame).
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        wskit: { channel: 'lobby' },
        exclude: new Set(),
        claimedChannelKeys: new Set(['lobby']),
      }),
    ).toBe(false);

    // Top-level traffic is always captured by server-level replay.
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        wskit: {},
        exclude: new Set(),
        claimedChannelKeys: new Set(['rooms']),
      }),
    ).toBe(true);
  });

  it('skips frames with correlationId — request responses are private and must not be replayed', () => {
    // Server-level replay.
    expect(
      shouldStoreReplayMessage('get-token', {
        channelKey: undefined,
        wskit: { correlationId: 'req-abc' },
        exclude: new Set(),
      }),
    ).toBe(false);
    // Channel-scoped replay.
    expect(
      shouldStoreReplayMessage('get-token', {
        channelKey: 'rooms',
        wskit: { correlationId: 'req-abc', channel: 'room-1', channelScope: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(false);
    // Sanity: the same frame without correlationId is captured.
    expect(
      shouldStoreReplayMessage('message', { channelKey: undefined, wskit: {}, exclude: new Set() }),
    ).toBe(true);
  });

  it('skips frames with streamId — stream chunks reference an active stream and cannot be replayed', () => {
    // Server-level replay.
    expect(
      shouldStoreReplayMessage('token', {
        channelKey: undefined,
        wskit: { streamId: 'stream_abc_1' },
        exclude: new Set(),
      }),
    ).toBe(false);
    // Channel-scoped replay.
    expect(
      shouldStoreReplayMessage('token', {
        channelKey: 'rooms',
        wskit: { streamId: 'stream_abc_1', channel: 'room-1', channelScope: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(false);
    // Sanity: the same frame without streamId is captured.
    expect(
      shouldStoreReplayMessage('token', { channelKey: undefined, wskit: {}, exclude: new Set() }),
    ).toBe(true);
  });

  it('builds replay rows from pure payloads and wskit metadata', () => {
    const payload = { text: 'hello' };
    const wskit = {
      seq: 7,
      messageId: 'msg_1',
      channel: 'room-1',
      channelScope: 'rooms',
    };

    expect(readReplayScope(wskit)).toEqual({
      namespace: null,
      channel: 'room-1',
      channelScope: 'rooms',
    });

    expect(
      buildReplayRow('message', {
        options: {
          type: 'snapshot',
          snapshotKey: (_event: string, next: Record<string, unknown>) => String(next.text),
        },
        payload,
        wskit,
        now: 99,
      }),
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

    expect(
      JSON.parse(
        buildReplayRow('message', { options: { type: 'history' }, payload, wskit, now: 99 })
          .payload,
      ),
    ).toEqual({
      text: 'hello',
    });
  });

  it('persists history rows, supports snapshot reducers, and deletes snapshots on null', () => {
    const { rows, sql } = createReplaySql();

    const history = persistReplayMessage(sql, {
      options: { type: 'history' },
      event: 'message',
      payload: { text: 'one' },
      wskit: { seq: 1, messageId: 'msg_1' },
      now: 100,
    });

    expect(history?.rowKey).toBe('msg_1');
    expect(rows.get('msg_1')?.payload).toBe(JSON.stringify({ text: 'one' }));

    persistReplayMessage(sql, {
      options: {
        type: 'snapshot',
        snapshotKey: (_event: string, payload: Record<string, unknown>) => String(payload.id),
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
      event: 'doc-content-set',
      payload: { id: 'doc-1', content: 'hello' },
      wskit: { seq: 2, messageId: 'msg_2' },
      now: 101,
    });

    const snapshot = rows.get('snapshot||||doc-1');
    expect(snapshot).toMatchObject({
      event: 'doc-snapshot',
      snapshotKey: 'doc-1',
    });
    expect(JSON.parse(snapshot?.payload ?? '{}')).toEqual({
      id: 'doc-1',
      title: '',
      content: 'hello',
    });

    persistReplayMessage(sql, {
      options: {
        type: 'snapshot',
        snapshotKey: (_event: string, payload: Record<string, unknown>) => String(payload.id),
        reduce() {
          return null;
        },
      },
      event: 'doc-deleted',
      payload: { id: 'doc-1' },
      wskit: { seq: 3, messageId: 'msg_3' },
      now: 102,
    });

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

    pruneReplayScopeRows(
      sql,
      { maxMessages: 2 },
      { namespace: null, channel: 'room-1', channelScope: 'rooms' },
    );
    expect([...rows.keys()]).not.toContain('c1');

    expect(
      loadReplayRows(sql, 1, { channelScope: null } as {
        channelName?: string;
        channelScope: string | null;
      }).map((row) => row.seq),
    ).toEqual([2]);
    expect(
      loadReplayRows(sql, 2, { channelName: 'room-1', channelScope: 'rooms' }).map(
        (row) => row.seq,
      ),
    ).toEqual([4, 5]);
  });

  describe('isChannelReplayAuthorized', () => {
    function makeConnection(memberships: { name: string; scope?: string }[]): RuntimeConnection {
      const map = new Map<string, { channelName: string; channelScope: string | null }>();
      for (const m of memberships) {
        const scope: string | null = m.scope ?? null;
        map.set(createChannelMembershipKey(m.name, scope), {
          channelName: m.name,
          channelScope: scope,
        });
      }
      return { channelMemberships: map } as unknown as RuntimeConnection;
    }

    it('returns true when no channel scope is on the request', () => {
      expect(isChannelReplayAuthorized(undefined, {}, undefined)).toBe(true);
      expect(isChannelReplayAuthorized(makeConnection([]), {}, { channelScope: null })).toBe(true);
    });

    it('returns false when channel scope is present but no connection is supplied', () => {
      expect(isChannelReplayAuthorized(undefined, { channelName: 'private' }, undefined)).toBe(
        false,
      );
    });

    it('returns false when the connection has no membership matching the channel + scope', () => {
      const conn = makeConnection([{ name: 'public', scope: 'rooms' }]);
      expect(
        isChannelReplayAuthorized(conn, { channelName: 'private' }, { channelScope: 'rooms' }),
      ).toBe(false);
    });

    it('returns true when the connection is a member of the requested channel + scope', () => {
      const conn = makeConnection([{ name: 'private', scope: 'rooms' }]);
      expect(
        isChannelReplayAuthorized(conn, { channelName: 'private' }, { channelScope: 'rooms' }),
      ).toBe(true);
    });

    it('returns true for a static channel membership when the request omits channelScope', () => {
      const conn = makeConnection([{ name: 'lobby' }]);
      expect(
        isChannelReplayAuthorized(conn, { channelName: 'lobby' }, { channelScope: null }),
      ).toBe(true);
    });
  });

  it('loads rows for a static channel using the explicit null scope marker', () => {
    const { rows, sql } = createReplaySql();

    rows.set('s1', {
      rowKey: 's1',
      messageId: 'msg_s1',
      seq: 1,
      event: 'room-msg',
      payload: '{}',
      namespace: null,
      channel: 'replay-room',
      channelScope: null,
      snapshotKey: null,
      createdAt: 100,
    });
    rows.set('s2', {
      rowKey: 's2',
      messageId: 'msg_s2',
      seq: 2,
      event: 'room-msg',
      payload: '{}',
      namespace: null,
      channel: 'replay-room',
      channelScope: null,
      snapshotKey: null,
      createdAt: 110,
    });

    const result = loadReplayRows(sql, 0, {
      channelName: 'replay-room',
      channelScope: null,
    });
    expect(result.map((row) => row.seq)).toEqual([1, 2]);
  });
});

describe('buildLoadReplayQuery', () => {
  it('produces the static-channel query (channelScope IS NULL) when scope.channelScope is null', () => {
    const query = buildLoadReplayQuery(0, { channelName: 'lobby', channelScope: null });
    expect(query.sql).toMatch(/channelScope\s+IS\s+NULL/);
    expect(query.sql).not.toMatch(/channelScope\s+IS\s+\?/);
    expect(query.params).toEqual(['lobby', 0]);
  });

  it('produces the family query when scope.channelScope is a non-null family key', () => {
    const query = buildLoadReplayQuery(7, { channelName: 'room:1', channelScope: 'rooms' });
    expect(query.sql).toMatch(/channelScope\s+IS\s+\?/);
    expect(query.params).toEqual(['room:1', 'rooms', 7]);
  });

  it('still produces the family query when the family key happens to equal the channel name', () => {
    // Regression: the previous heuristic compared scope.channelScope to
    // scope.channelName and silently fell into the static path. Now the
    // null-vs-string marker drives the branch, so a family with key 'rooms'
    // and concrete name 'rooms' resolves as a family query.
    const query = buildLoadReplayQuery(0, { channelName: 'rooms', channelScope: 'rooms' });
    expect(query.sql).toMatch(/channelScope\s+IS\s+\?/);
    expect(query.sql).not.toMatch(/channelScope\s+IS\s+NULL/);
    expect(query.params).toEqual(['rooms', 'rooms', 0]);
  });

  it('produces the unscoped top-level query when no channelName is provided', () => {
    const query = buildLoadReplayQuery(0, { channelScope: null });
    expect(query.sql).toMatch(/namespace IS NULL/);
    expect(query.sql).toMatch(/channel IS NULL/);
    expect(query.sql).toMatch(/channelScope IS NULL/);
    expect(query.params).toEqual([0]);
  });
});

describe('assertReplayScopeServable', () => {
  it('throws ValidationFailed when top-level replay receives a namespace request', () => {
    let captured: unknown;
    try {
      assertReplayScopeServable(undefined, { namespaceName: 'admin' });
    } catch (error) {
      captured = error;
    }
    expect(ValidationFailed.matches(captured)).toBe(true);
  });

  it('passes through when top-level replay receives a non-namespace request', () => {
    expect(() => assertReplayScopeServable(undefined, {})).not.toThrow();
  });

  it('passes through for channel-level replay regardless of namespace marker', () => {
    // Resolve order in the engine prevents namespace and channel markers from
    // both being set on the same incoming frame, but the helper does not
    // depend on that — channel replay simply does not gate on namespace.
    expect(() => assertReplayScopeServable('rooms', {})).not.toThrow();
    expect(() => assertReplayScopeServable('rooms', { namespaceName: 'admin' })).not.toThrow();
  });
});
