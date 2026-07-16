import { ReplayFrame } from '~/_engine/runtime/protocol.ts';
import { createTestSql } from '~/_test/sql.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import {
  buildLoadReplayQuery,
  buildReplayRow,
  bumpReplayWatermark,
  ensureReplaySchema,
  getReplayRowByKey,
  isChannelReplayAuthorized,
  loadReplayRows,
  matchesReplayScope,
  persistReplayMessage,
  pruneExpiredReplayRows,
  pruneReplayScopeRows,
  readReplayScope,
  readReplayWatermark,
  replayScopeKey,
  shouldStoreReplayMessage,
  storeReplayRow,
} from './runtime.ts';
import type { ReplayRow } from './types.ts';

function replayDb() {
  const sql = createTestSql();
  ensureReplaySchema(sql);
  return sql;
}

function replayKeys(sql: ReturnType<typeof createTestSql>): string[] {
  return sql
    .exec<{ rowKey: string }>('SELECT rowKey FROM __wskit_replay')
    .toArray()
    .map((row) => row.rowKey);
}

function replaySeqs(sql: ReturnType<typeof createTestSql>): number[] {
  return sql
    .exec<{ seq: number }>('SELECT seq FROM __wskit_replay')
    .toArray()
    .map((row) => Number(row.seq));
}

describe('replay/runtime', () => {
  it('creates the replay schema and indexes in one round trip', () => {
    const sql = createTestSql();
    ensureReplaySchema(sql);

    const created = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
      .toArray()
      .map((row) => row.name);

    expect(created).toContain('__wskit_replay');
    expect(created).toContain('__wskit_idx_replay_seq');
    expect(created).toContain('__wskit_idx_replay_scope_seq');
    expect(created).toContain('__wskit_replay_watermark');
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
    expect(matchesReplayScope('rooms', { channelFamily: 'rooms' })).toBe(true);
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: 'rooms',
        wskit: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(['typing']),
      }),
    ).toBe(true);
    expect(
      shouldStoreReplayMessage('typing', {
        channelKey: 'rooms',
        wskit: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(['typing']),
      }),
    ).toBe(false);
  });

  it('server-level shouldStoreReplayMessage cascades into channels not in the claimed set', () => {
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        wskit: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(true);

    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        wskit: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
        claimedChannelKeys: new Set(['rooms']),
      }),
    ).toBe(false);

    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        wskit: { channel: 'lobby' },
        exclude: new Set(),
        claimedChannelKeys: new Set(['lobby']),
      }),
    ).toBe(false);

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
    expect(
      shouldStoreReplayMessage('get-token', {
        channelKey: undefined,
        wskit: { correlationId: 'req-abc' },
        exclude: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStoreReplayMessage('get-token', {
        channelKey: 'rooms',
        wskit: { correlationId: 'req-abc', channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStoreReplayMessage('message', { channelKey: undefined, wskit: {}, exclude: new Set() }),
    ).toBe(true);
  });

  it('skips frames with streamId — stream chunks reference an active stream and cannot be replayed', () => {
    expect(
      shouldStoreReplayMessage('token', {
        channelKey: undefined,
        wskit: { streamId: 'stream_abc_1' },
        exclude: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStoreReplayMessage('token', {
        channelKey: 'rooms',
        wskit: { streamId: 'stream_abc_1', channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStoreReplayMessage('token', { channelKey: undefined, wskit: {}, exclude: new Set() }),
    ).toBe(true);
  });

  it('skips protocol/control frames — presence and other __…__ events are bookkeeping, not replayable', () => {
    // Presence on a replay-enabled channel: must not be recorded (it carries no
    // seq, so storing it would throw). It's re-derived via __memberSync__ on
    // reconnect, so dropping it from replay loses nothing.
    expect(
      shouldStoreReplayMessage('__memberOffline__', {
        channelKey: 'rooms',
        wskit: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(false);
    for (const event of ['__memberJoin__', '__subscribeOk__', '__error__', '__streamEnd__']) {
      expect(
        shouldStoreReplayMessage(event, { channelKey: undefined, wskit: {}, exclude: new Set() }),
      ).toBe(false);
    }
    expect(
      shouldStoreReplayMessage('room-msg', {
        channelKey: 'rooms',
        wskit: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(true);
  });

  it('builds replay rows from pure payloads and wskit metadata', () => {
    const payload = { text: 'hello' };
    const wskit = {
      seq: 7,
      messageId: 'msg_1',
      channel: 'room-1',
      channelFamily: 'rooms',
    };

    expect(readReplayScope(wskit)).toEqual({
      channel: 'room-1',
      channelFamily: 'rooms',
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
      rowKey: JSON.stringify(['snapshot', 'room-1', 'rooms', 'hello']),
      messageId: 'msg_1',
      seq: 7,
      event: 'message',
      channel: 'room-1',
      channelFamily: 'rooms',
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

  it('builds collision-safe snapshot keys for ambiguous channel/scope/key tuples (#6)', () => {
    const base = { payload: {}, now: 0 } as const;
    // channel `a|b`, no scope, key `c`  vs  channel `a`, scope `b`, key `|c`.
    // A raw `|` join makes both `snapshot|a|b||c`; JSON encoding keeps them apart.
    const a = buildReplayRow('e', {
      options: { type: 'snapshot', snapshotKey: () => 'c' },
      wskit: { seq: 1, messageId: 'm', channel: 'a|b' },
      ...base,
    });
    const b = buildReplayRow('e', {
      options: { type: 'snapshot', snapshotKey: () => '|c' },
      wskit: { seq: 1, messageId: 'm', channel: 'a', channelFamily: 'b' },
      ...base,
    });
    expect(a.rowKey).not.toBe(b.rowKey);
  });

  it('persists history rows, supports snapshot reducers, and deletes snapshots on null', () => {
    const sql = replayDb();

    const history = persistReplayMessage(sql, {
      options: { type: 'history' },
      event: 'message',
      payload: { text: 'one' },
      wskit: { seq: 1, messageId: 'msg_1' },
      now: 100,
    });

    expect(history?.rowKey).toBe('msg_1');
    expect(getReplayRowByKey(sql, 'msg_1')?.payload).toBe(JSON.stringify({ text: 'one' }));

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

    const snapshot = getReplayRowByKey(sql, JSON.stringify(['snapshot', '', '', 'doc-1']));
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

    expect(getReplayRowByKey(sql, JSON.stringify(['snapshot', '', '', 'doc-1']))).toBeNull();
  });

  it('prunes retained rows and loads replay rows in sequence order', () => {
    const sql = replayDb();

    storeReplayRow(sql, {
      rowKey: 'old',
      messageId: 'msg_old',
      seq: 1,
      event: 'message',
      payload: '{}',
      channel: null,
      channelFamily: null,
      snapshotKey: null,
      createdAt: 10,
    });
    storeReplayRow(sql, {
      rowKey: 'new',
      messageId: 'msg_new',
      seq: 2,
      event: 'message',
      payload: '{}',
      channel: null,
      channelFamily: null,
      snapshotKey: null,
      createdAt: 90,
    });
    storeReplayRow(sql, {
      rowKey: 'c1',
      messageId: 'msg_c1',
      seq: 3,
      event: 'message',
      payload: '{}',
      channel: 'room-1',
      channelFamily: 'rooms',
      snapshotKey: null,
      createdAt: 100,
    });
    storeReplayRow(sql, {
      rowKey: 'c2',
      messageId: 'msg_c2',
      seq: 4,
      event: 'message',
      payload: '{}',
      channel: 'room-1',
      channelFamily: 'rooms',
      snapshotKey: null,
      createdAt: 110,
    });
    storeReplayRow(sql, {
      rowKey: 'c3',
      messageId: 'msg_c3',
      seq: 5,
      event: 'message',
      payload: '{}',
      channel: 'room-1',
      channelFamily: 'rooms',
      snapshotKey: null,
      createdAt: 120,
    });

    pruneExpiredReplayRows(sql, { maxAgeMs: 20 }, 100);
    expect(getReplayRowByKey(sql, 'old')).toBeNull();

    pruneReplayScopeRows(sql, { maxMessages: 2 }, { channel: 'room-1', channelFamily: 'rooms' });
    expect(replayKeys(sql)).not.toContain('c1');

    expect(
      loadReplayRows(sql, 1, { channelFamily: null } as {
        channelName?: string;
        channelFamily: string | null;
      }).map((row) => row.seq),
    ).toEqual([2]);
    expect(
      loadReplayRows(sql, 2, { channelName: 'room-1', channelFamily: 'rooms' }).map(
        (row) => row.seq,
      ),
    ).toEqual([4, 5]);
  });

  it('top-level maxMessages counts the whole top-level store as one scope', () => {
    const sql = replayDb();

    // Four top-level rows. All belong to the single top-level scope. With
    // maxMessages: 2 the trim must keep the two newest across ALL of them.
    function make(key: string, seq: number): ReplayRow {
      return {
        rowKey: key,
        messageId: `msg_${key}`,
        seq,
        event: 'message',
        payload: '{}',
        channel: null,
        channelFamily: null,
        snapshotKey: null,
        createdAt: seq,
      };
    }
    storeReplayRow(sql, make('a', 1));
    storeReplayRow(sql, make('b', 2));
    storeReplayRow(sql, make('c', 3));
    storeReplayRow(sql, make('d', 4));

    pruneReplayScopeRows(sql, { maxMessages: 2 }, { channel: null, channelFamily: null });

    const surviving = loadReplayRows(sql, 0, { channelFamily: null } as {
      channelName?: string;
      channelFamily: string | null;
    }).map((row) => row.seq);
    expect(surviving).toEqual([3, 4]);
  });

  describe('isChannelReplayAuthorized', () => {
    function makeConnection(memberships: { name: string; scope?: string }[]): RuntimeConnection {
      const map = new Map<string, { channelName: string; channelFamily: string | null }>();
      for (const m of memberships) {
        const scope: string | null = m.scope ?? null;
        map.set(createChannelMembershipKey(m.name, scope), {
          channelName: m.name,
          channelFamily: scope,
        });
      }
      return { channelMemberships: map } as unknown as RuntimeConnection;
    }

    it('returns true when no channel scope is on the request', () => {
      expect(isChannelReplayAuthorized(undefined, {}, undefined)).toBe(true);
      expect(isChannelReplayAuthorized(makeConnection([]), {}, { channelFamily: null })).toBe(true);
    });

    it('returns false when channel scope is present but no connection is supplied', () => {
      expect(isChannelReplayAuthorized(undefined, { channelName: 'private' }, undefined)).toBe(
        false,
      );
    });

    it('returns false when the connection has no membership matching the channel + scope', () => {
      const conn = makeConnection([{ name: 'public', scope: 'rooms' }]);
      expect(
        isChannelReplayAuthorized(conn, { channelName: 'private' }, { channelFamily: 'rooms' }),
      ).toBe(false);
    });

    it('returns true when the connection is a member of the requested channel + scope', () => {
      const conn = makeConnection([{ name: 'private', scope: 'rooms' }]);
      expect(
        isChannelReplayAuthorized(conn, { channelName: 'private' }, { channelFamily: 'rooms' }),
      ).toBe(true);
    });

    it('returns true for a static channel membership when the request omits channelFamily', () => {
      const conn = makeConnection([{ name: 'lobby' }]);
      expect(
        isChannelReplayAuthorized(conn, { channelName: 'lobby' }, { channelFamily: null }),
      ).toBe(true);
    });
  });

  it('loads rows for a static channel using the explicit null scope marker', () => {
    const sql = replayDb();

    storeReplayRow(sql, {
      rowKey: 's1',
      messageId: 'msg_s1',
      seq: 1,
      event: 'room-msg',
      payload: '{}',
      channel: 'replay-room',
      channelFamily: null,
      snapshotKey: null,
      createdAt: 100,
    });
    storeReplayRow(sql, {
      rowKey: 's2',
      messageId: 'msg_s2',
      seq: 2,
      event: 'room-msg',
      payload: '{}',
      channel: 'replay-room',
      channelFamily: null,
      snapshotKey: null,
      createdAt: 110,
    });

    const result = loadReplayRows(sql, 0, {
      channelName: 'replay-room',
      channelFamily: null,
    });
    expect(result.map((row) => row.seq)).toEqual([1, 2]);
  });

  it('top-level replay returns every non-channel row in one gap', () => {
    // Replay has two scopes only: top-level and channel. A top-level "catch me
    // up since seq N" request returns the whole gap of non-channel rows.
    const sql = replayDb();

    storeReplayRow(sql, {
      rowKey: 'n1',
      messageId: 'msg_n1',
      seq: 1,
      event: 'notice',
      payload: '{}',
      channel: null,
      channelFamily: null,
      snapshotKey: null,
      createdAt: 100,
    });
    storeReplayRow(sql, {
      rowKey: 'n2',
      messageId: 'msg_n2',
      seq: 2,
      event: 'notice',
      payload: '{}',
      channel: null,
      channelFamily: null,
      snapshotKey: null,
      createdAt: 110,
    });

    const result = loadReplayRows(sql, 0, { channelFamily: null });
    expect(result.map((row) => row.seq)).toEqual([1, 2]);
  });

  describe('eviction watermark', () => {
    function makeRow(overrides: Partial<ReplayRow> & { seq: number }): ReplayRow {
      const { seq } = overrides;
      return {
        rowKey: `k${seq}`,
        messageId: `msg_${seq}`,
        event: 'message',
        payload: '{}',
        channel: null,
        channelFamily: null,
        snapshotKey: null,
        createdAt: seq,
        ...overrides,
      };
    }

    it('keys the top-level scope as an empty string and a channel scope like the membership key', () => {
      expect(replayScopeKey({ channel: null, channelFamily: null })).toBe('');
      // A present channel always marks a channel scope, even for a static channel
      // (null family) — mirroring JSON.stringify([channelFamily, channel]).
      expect(replayScopeKey({ channel: 'lobby', channelFamily: null })).toBe(
        JSON.stringify([null, 'lobby']),
      );
      expect(replayScopeKey({ channel: 'room-1', channelFamily: 'rooms' })).toBe(
        JSON.stringify(['rooms', 'room-1']),
      );
    });

    it('upserts the watermark monotonically — a later, lower seq never lowers it', () => {
      const sql = replayDb();
      bumpReplayWatermark(sql, '', 10);
      expect(readReplayWatermark(sql, '')).toBe(10);
      bumpReplayWatermark(sql, '', 5);
      expect(readReplayWatermark(sql, '')).toBe(10);
      bumpReplayWatermark(sql, '', 20);
      expect(readReplayWatermark(sql, '')).toBe(20);
    });

    it('returns null for a scope that has never evicted anything', () => {
      const sql = replayDb();
      expect(readReplayWatermark(sql, '')).toBeNull();
    });

    it('age prune bumps each scope watermark to its own highest evicted seq before deleting', () => {
      const sql = replayDb();
      // Two scopes, mixed ages. maxAgeMs cutoff drops seq 1,2 (top-level) and
      // seq 3 (room-1). The watermark per scope is the highest evicted seq there.
      storeReplayRow(sql, makeRow({ rowKey: 't1', seq: 1, createdAt: 10 }));
      storeReplayRow(sql, makeRow({ rowKey: 't2', seq: 2, createdAt: 20 }));
      storeReplayRow(sql, makeRow({ rowKey: 't3', seq: 4, createdAt: 90 }));
      storeReplayRow(
        sql,
        makeRow({ rowKey: 'r1', seq: 3, createdAt: 15, channel: 'room-1', channelFamily: 'rooms' }),
      );
      storeReplayRow(
        sql,
        makeRow({ rowKey: 'r2', seq: 6, createdAt: 95, channel: 'room-1', channelFamily: 'rooms' }),
      );

      // now=100, maxAgeMs=50 → cutoff 50: anything with createdAt < 50 is evicted.
      pruneExpiredReplayRows(sql, { maxAgeMs: 50 }, 100);

      expect(replayKeys(sql).sort()).toEqual(['r2', 't3']);
      expect(readReplayWatermark(sql, '')).toBe(2);
      expect(
        readReplayWatermark(sql, replayScopeKey({ channel: 'room-1', channelFamily: 'rooms' })),
      ).toBe(3);
    });

    it('age prune with no matching rows leaves the watermark untouched', () => {
      const sql = replayDb();
      storeReplayRow(sql, makeRow({ rowKey: 't1', seq: 1, createdAt: 90 }));
      pruneExpiredReplayRows(sql, { maxAgeMs: 50 }, 100);
      expect(readReplayWatermark(sql, '')).toBeNull();
    });

    it('count prune records the highest seq among the dropped tail as the watermark', () => {
      const sql = replayDb();
      // Five rows in one channel scope; maxMessages 2 keeps seq 4,5 and drops
      // 1,2,3. The watermark is the highest dropped seq (3).
      for (const seq of [1, 2, 3, 4, 5]) {
        storeReplayRow(
          sql,
          makeRow({ rowKey: `c${seq}`, seq, channel: 'room-1', channelFamily: 'rooms' }),
        );
      }
      pruneReplayScopeRows(sql, { maxMessages: 2 }, { channel: 'room-1', channelFamily: 'rooms' });

      const key = replayScopeKey({ channel: 'room-1', channelFamily: 'rooms' });
      expect(readReplayWatermark(sql, key)).toBe(3);
      expect(replaySeqs(sql).sort((a, b) => a - b)).toEqual([4, 5]);
    });

    it('count prune under the limit drops nothing and records no watermark', () => {
      const sql = replayDb();
      storeReplayRow(sql, makeRow({ rowKey: 'c1', seq: 1 }));
      storeReplayRow(sql, makeRow({ rowKey: 'c2', seq: 2 }));
      pruneReplayScopeRows(sql, { maxMessages: 5 }, { channel: null, channelFamily: null });
      expect(readReplayWatermark(sql, '')).toBeNull();
    });

    it('count prune raises but never lowers an existing higher watermark', () => {
      const sql = replayDb();
      bumpReplayWatermark(sql, '', 100);
      for (const seq of [1, 2, 3]) storeReplayRow(sql, makeRow({ rowKey: `c${seq}`, seq }));
      // Dropping seq 1 would set watermark 1, but 100 already stands, so MAX wins.
      pruneReplayScopeRows(sql, { maxMessages: 2 }, { channel: null, channelFamily: null });
      expect(readReplayWatermark(sql, '')).toBe(100);
    });
  });
});

describe('buildLoadReplayQuery', () => {
  it('produces the static-channel query (channelFamily IS NULL) when scope.channelFamily is null', () => {
    const query = buildLoadReplayQuery(0, { channelName: 'lobby', channelFamily: null });
    expect(query.sql).toMatch(/channelFamily\s+IS\s+NULL/);
    expect(query.sql).not.toMatch(/channelFamily\s+IS\s+\?/);
    expect(query.params).toEqual(['lobby', 0]);
  });

  it('produces the family query when scope.channelFamily is a non-null family key', () => {
    const query = buildLoadReplayQuery(7, { channelName: 'room:1', channelFamily: 'rooms' });
    expect(query.sql).toMatch(/channelFamily\s+IS\s+\?/);
    expect(query.params).toEqual(['room:1', 'rooms', 7]);
  });

  it('still produces the family query when the family key happens to equal the channel name', () => {
    // Regression: the previous heuristic compared scope.channelFamily to
    // scope.channelName and silently fell into the static path. Now the
    // null-vs-string marker drives the branch, so a family with key 'rooms'
    // and concrete name 'rooms' resolves as a family query.
    const query = buildLoadReplayQuery(0, { channelName: 'rooms', channelFamily: 'rooms' });
    expect(query.sql).toMatch(/channelFamily\s+IS\s+\?/);
    expect(query.sql).not.toMatch(/channelFamily\s+IS\s+NULL/);
    expect(query.params).toEqual(['rooms', 'rooms', 0]);
  });

  it('produces the top-level query when no channelName is provided', () => {
    const query = buildLoadReplayQuery(0, { channelFamily: null });
    expect(query.sql).toMatch(/channel IS NULL/);
    expect(query.sql).toMatch(/channelFamily IS NULL/);
    expect(query.params).toEqual([0]);
  });
});

describe('ReplayFrame schema', () => {
  it('accepts a top-level replay frame with no scope markers', () => {
    const result = v.safeParse(ReplayFrame, {
      event: '__replay__',
      payload: { lastKnownSeq: 5 },
      __wskit: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts a channel-scoped replay frame', () => {
    const result = v.safeParse(ReplayFrame, {
      event: '__replay__',
      payload: {},
      __wskit: { channel: 'room', channelFamily: 'rooms' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a replay frame that carries an unknown routing marker', () => {
    // The replay frame's __wskit carries only known routing keys; a stray
    // unknown marker must fail validation, not be silently ignored.
    const result = v.safeParse(ReplayFrame, {
      event: '__replay__',
      payload: {},
      __wskit: { bogus: 'admin' },
    });
    expect(result.success).toBe(false);
  });
});
