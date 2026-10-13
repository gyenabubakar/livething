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
  readReplayGapWatermark,
  readReplayScope,
  readReplayWatermark,
  replayScopeKey,
  shouldStoreReplayMessage,
  storeReplayRow,
} from './runtime.ts';
import type { ReplayRow } from './types.ts';

const SERVER_OWNER = { channelKey: undefined, claimedChannelKeys: new Set<string>() };

function replayDb() {
  const sql = createTestSql();
  ensureReplaySchema(sql);
  return sql;
}

function replayKeys(sql: ReturnType<typeof createTestSql>): string[] {
  return sql
    .exec<{ rowKey: string }>('SELECT rowKey FROM __livething_replay')
    .toArray()
    .map((row) => row.rowKey);
}

function replaySeqs(sql: ReturnType<typeof createTestSql>): number[] {
  return sql
    .exec<{ seq: number }>('SELECT seq FROM __livething_replay')
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

    expect(created).toContain('__livething_replay');
    expect(created).toContain('__livething_idx_replay_seq');
    expect(created).toContain('__livething_idx_replay_scope_seq');
    expect(created).toContain('__livething_replay_watermark');
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
        livething: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(['typing']),
      }),
    ).toBe(true);
    expect(
      shouldStoreReplayMessage('typing', {
        channelKey: 'rooms',
        livething: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(['typing']),
      }),
    ).toBe(false);
  });

  it('server-level shouldStoreReplayMessage cascades into channels not in the claimed set', () => {
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        livething: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(true);

    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        livething: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
        claimedChannelKeys: new Set(['rooms']),
      }),
    ).toBe(false);

    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        livething: { channel: 'lobby' },
        exclude: new Set(),
        claimedChannelKeys: new Set(['lobby']),
      }),
    ).toBe(false);

    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        livething: {},
        exclude: new Set(),
        claimedChannelKeys: new Set(['rooms']),
      }),
    ).toBe(true);
  });

  it('skips frames with correlationId — request responses are private and must not be replayed', () => {
    expect(
      shouldStoreReplayMessage('get-token', {
        channelKey: undefined,
        livething: { correlationId: 'req-abc' },
        exclude: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStoreReplayMessage('get-token', {
        channelKey: 'rooms',
        livething: { correlationId: 'req-abc', channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStoreReplayMessage('message', {
        channelKey: undefined,
        livething: {},
        exclude: new Set(),
      }),
    ).toBe(true);
  });

  it('skips frames with streamId — stream chunks reference an active stream and cannot be replayed', () => {
    expect(
      shouldStoreReplayMessage('token', {
        channelKey: undefined,
        livething: { streamId: 'stream_abc_1' },
        exclude: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStoreReplayMessage('token', {
        channelKey: 'rooms',
        livething: { streamId: 'stream_abc_1', channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStoreReplayMessage('token', {
        channelKey: undefined,
        livething: {},
        exclude: new Set(),
      }),
    ).toBe(true);
  });

  it('skips protocol/control frames — presence and other __…__ events are bookkeeping, not replayable', () => {
    // Presence on a replay-enabled channel: must not be recorded (it carries no
    // seq, so storing it would throw). It's re-derived via __memberSync__ on
    // reconnect, so dropping it from replay loses nothing.
    expect(
      shouldStoreReplayMessage('__memberOffline__', {
        channelKey: 'rooms',
        livething: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(false);
    for (const event of ['__memberJoin__', '__subscribeOk__', '__error__', '__streamEnd__']) {
      expect(
        shouldStoreReplayMessage(event, {
          channelKey: undefined,
          livething: {},
          exclude: new Set(),
        }),
      ).toBe(false);
    }

    expect(
      shouldStoreReplayMessage('room-msg', {
        channelKey: 'rooms',
        livething: { channel: 'room-1', channelFamily: 'rooms' },
        exclude: new Set(),
      }),
    ).toBe(true);
  });

  it('builds replay rows from pure payloads and livething metadata', () => {
    const payload = { text: 'hello' };
    const livething = {
      deliverySeq: 7,
      messageId: 'msg_1',
      channel: 'room-1',
      channelFamily: 'rooms',
    };

    expect(readReplayScope(livething)).toEqual({
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
        livething,
        now: 99,
      }),
    ).toMatchObject({
      rowKey: JSON.stringify(['snapshot', 'room-1', 'rooms', 'hello', null]),
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
        buildReplayRow('message', { options: { type: 'history' }, payload, livething, now: 99 })
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
      livething: { deliverySeq: 1, messageId: 'm', channel: 'a|b' },
      ...base,
    });
    const b = buildReplayRow('e', {
      options: { type: 'snapshot', snapshotKey: () => '|c' },
      livething: { deliverySeq: 1, messageId: 'm', channel: 'a', channelFamily: 'b' },
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
      livething: { deliverySeq: 1, messageId: 'msg_1' },
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
      livething: { deliverySeq: 2, messageId: 'msg_2' },
      now: 101,
    });

    const snapshot = getReplayRowByKey(sql, JSON.stringify(['snapshot', '', '', 'doc-1', null]));
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
      livething: { deliverySeq: 3, messageId: 'msg_3' },
      now: 102,
    });

    expect(getReplayRowByKey(sql, JSON.stringify(['snapshot', '', '', 'doc-1', null]))).toBeNull();
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
      userId: null,
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
      userId: null,
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
      userId: null,
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
      userId: null,
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
      userId: null,
      snapshotKey: null,
      createdAt: 120,
    });

    pruneExpiredReplayRows(sql, { retention: { maxAgeMs: 20 }, now: 100, owner: SERVER_OWNER });
    expect(getReplayRowByKey(sql, 'old')).toBeNull();

    pruneReplayScopeRows(sql, { maxMessages: 2 }, { channel: 'room-1', channelFamily: 'rooms' });
    expect(replayKeys(sql)).not.toContain('c1');

    expect(
      loadReplayRows(sql, 1, { channelFamily: null, userId: null }).map((row) => row.seq),
    ).toEqual([2]);
    expect(
      loadReplayRows(sql, 2, { channelName: 'room-1', channelFamily: 'rooms', userId: null }).map(
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
        userId: null,
        snapshotKey: null,
        createdAt: seq,
      };
    }

    storeReplayRow(sql, make('a', 1));
    storeReplayRow(sql, make('b', 2));
    storeReplayRow(sql, make('c', 3));
    storeReplayRow(sql, make('d', 4));

    pruneReplayScopeRows(sql, { maxMessages: 2 }, { channel: null, channelFamily: null });

    const surviving = loadReplayRows(sql, 0, { channelFamily: null, userId: null }).map(
      (row) => row.seq,
    );
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
      userId: null,
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
      userId: null,
      snapshotKey: null,
      createdAt: 110,
    });

    const result = loadReplayRows(sql, 0, {
      channelName: 'replay-room',
      channelFamily: null,
      userId: null,
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
      userId: null,
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
      userId: null,
      snapshotKey: null,
      createdAt: 110,
    });

    const result = loadReplayRows(sql, 0, { channelFamily: null, userId: null });
    expect(result.map((row) => row.seq)).toEqual([1, 2]);
  });

  it('loads a user-addressed row only for that user', () => {
    const sql = replayDb();
    function row(rowKey: string, seq: number, userId: string | null): ReplayRow {
      return {
        rowKey,
        messageId: `msg_${rowKey}`,
        seq,
        event: 'notice',
        payload: '{}',
        channel: null,
        channelFamily: null,
        userId,
        snapshotKey: null,
        createdAt: seq,
      };
    }

    storeReplayRow(sql, row('all', 1, null));
    storeReplayRow(sql, row('bob', 2, 'bob'));
    storeReplayRow(sql, row('carol', 3, 'carol'));

    function seqsFor(userId: string | null): number[] {
      return loadReplayRows(sql, 0, { channelFamily: null, userId }).map((loaded) => loaded.seq);
    }

    expect(seqsFor('bob')).toEqual([1, 2]);
    expect(seqsFor('carol')).toEqual([1, 3]);
    expect(seqsFor(null)).toEqual([1]);
  });

  it('keeps one snapshot per audience, so a user value never replaces the shared one', () => {
    const sql = replayDb();
    const options = { type: 'snapshot' as const, snapshotKey: () => 'doc' };
    persistReplayMessage(sql, {
      options,
      event: 'doc',
      payload: { v: 'shared' },
      livething: { deliverySeq: 1, messageId: 'm1' },
      now: 1,
    });
    persistReplayMessage(sql, {
      options,
      event: 'doc',
      payload: { v: 'bob-only' },
      livething: { deliverySeq: 2, messageId: 'm2' },
      userId: 'bob',
      now: 2,
    });

    function payloadsFor(userId: string | null): string[] {
      return loadReplayRows(sql, 0, { channelFamily: null, userId }).map(
        (loaded) => loaded.payload,
      );
    }

    expect(payloadsFor(null)).toEqual([JSON.stringify({ v: 'shared' })]);
    expect(payloadsFor('bob')).toEqual([
      JSON.stringify({ v: 'shared' }),
      JSON.stringify({ v: 'bob-only' }),
    ]);
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
        userId: null,
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
      pruneExpiredReplayRows(sql, { retention: { maxAgeMs: 50 }, now: 100, owner: SERVER_OWNER });

      expect(replayKeys(sql).sort()).toEqual(['r2', 't3']);
      expect(readReplayWatermark(sql, '')).toBe(2);
      expect(
        readReplayWatermark(sql, replayScopeKey({ channel: 'room-1', channelFamily: 'rooms' })),
      ).toBe(3);
    });

    it('server-level age prune leaves rows and watermarks of a channel that owns its own replay', () => {
      const sql = replayDb();
      storeReplayRow(sql, makeRow({ rowKey: 't1', seq: 1, createdAt: 10 }));
      storeReplayRow(
        sql,
        makeRow({
          rowKey: 'own1',
          seq: 2,
          createdAt: 10,
          channel: 'room-1',
          channelFamily: 'rooms',
        }),
      );
      storeReplayRow(
        sql,
        makeRow({ rowKey: 'lobby1', seq: 3, createdAt: 10, channel: 'lobby', channelFamily: null }),
      );
      storeReplayRow(
        sql,
        makeRow({ rowKey: 'open1', seq: 4, createdAt: 10, channel: 'open', channelFamily: null }),
      );

      pruneExpiredReplayRows(sql, {
        retention: { maxAgeMs: 50 },
        now: 100,
        owner: { channelKey: undefined, claimedChannelKeys: new Set(['rooms', 'lobby']) },
      });

      expect(replayKeys(sql).sort()).toEqual(['lobby1', 'own1']);
      expect(readReplayWatermark(sql, '')).toBe(1);
      expect(
        readReplayWatermark(sql, replayScopeKey({ channel: 'open', channelFamily: null })),
      ).toBe(4);
      expect(
        readReplayWatermark(sql, replayScopeKey({ channel: 'room-1', channelFamily: 'rooms' })),
      ).toBeNull();
      expect(
        readReplayWatermark(sql, replayScopeKey({ channel: 'lobby', channelFamily: null })),
      ).toBeNull();
    });

    it('channel-level age prune only touches its own channel rows', () => {
      const sql = replayDb();
      storeReplayRow(sql, makeRow({ rowKey: 't1', seq: 1, createdAt: 10 }));
      storeReplayRow(
        sql,
        makeRow({
          rowKey: 'own1',
          seq: 2,
          createdAt: 10,
          channel: 'room-1',
          channelFamily: 'rooms',
        }),
      );
      storeReplayRow(
        sql,
        makeRow({ rowKey: 'other1', seq: 3, createdAt: 10, channel: 'lobby', channelFamily: null }),
      );

      pruneExpiredReplayRows(sql, {
        retention: { maxAgeMs: 50 },
        now: 100,
        owner: { channelKey: 'rooms', claimedChannelKeys: new Set(['rooms']) },
      });

      expect(replayKeys(sql).sort()).toEqual(['other1', 't1']);
      expect(readReplayWatermark(sql, '')).toBeNull();
      expect(
        readReplayWatermark(sql, replayScopeKey({ channel: 'room-1', channelFamily: 'rooms' })),
      ).toBe(2);
    });

    it('age prune with no matching rows leaves the watermark untouched', () => {
      const sql = replayDb();
      storeReplayRow(sql, makeRow({ rowKey: 't1', seq: 1, createdAt: 90 }));
      pruneExpiredReplayRows(sql, { retention: { maxAgeMs: 50 }, now: 100, owner: SERVER_OWNER });
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

    it('age prune of a row sent to one user raises only that user’s gap mark', () => {
      const sql = replayDb();
      storeReplayRow(sql, makeRow({ rowKey: 't1', seq: 1, createdAt: 10 }));
      storeReplayRow(sql, makeRow({ rowKey: 't2', seq: 2, createdAt: 20, userId: 'alice' }));
      storeReplayRow(sql, makeRow({ rowKey: 't3', seq: 3, createdAt: 90 }));

      pruneExpiredReplayRows(sql, { retention: { maxAgeMs: 50 }, now: 100, owner: SERVER_OWNER });

      const scope = { channel: null, channelFamily: null };
      expect(readReplayGapWatermark(sql, scope, 'bob')).toBe(1);
      expect(readReplayGapWatermark(sql, scope, 'alice')).toBe(2);
    });

    it('count prune of a row sent to one user raises only that user’s gap mark', () => {
      const sql = replayDb();
      const room = { channel: 'room-1', channelFamily: 'rooms' };
      storeReplayRow(sql, makeRow({ rowKey: 'c1', seq: 1, ...room }));
      storeReplayRow(sql, makeRow({ rowKey: 'c2', seq: 2, ...room, userId: 'alice' }));
      storeReplayRow(sql, makeRow({ rowKey: 'c3', seq: 3, ...room }));

      pruneReplayScopeRows(sql, { maxMessages: 1 }, room);

      expect(readReplayGapWatermark(sql, room, 'bob')).toBe(1);
      expect(readReplayGapWatermark(sql, room, 'alice')).toBe(2);
      expect(readReplayGapWatermark(sql, room, null)).toBe(1);
    });
  });
});

describe('buildLoadReplayQuery', () => {
  it('produces the static-channel query (channelFamily IS NULL) when scope.channelFamily is null', () => {
    const query = buildLoadReplayQuery(0, {
      channelName: 'lobby',
      channelFamily: null,
      userId: null,
    });
    expect(query.sql).toMatch(/channelFamily\s+IS\s+NULL/);
    expect(query.sql).not.toMatch(/channelFamily\s+IS\s+\?/);
    expect(query.params).toEqual(['lobby', 0, null]);
  });

  it('produces the family query when scope.channelFamily is a non-null family key', () => {
    const query = buildLoadReplayQuery(7, {
      channelName: 'room:1',
      channelFamily: 'rooms',
      userId: 'alice',
    });
    expect(query.sql).toMatch(/channelFamily\s+IS\s+\?/);
    expect(query.params).toEqual(['room:1', 'rooms', 7, 'alice']);
  });

  it('produces the family query when the family key equals the channel name', () => {
    // The null-vs-string family marker keeps this in the family query path.
    const query = buildLoadReplayQuery(0, {
      channelName: 'rooms',
      channelFamily: 'rooms',
      userId: null,
    });
    expect(query.sql).toMatch(/channelFamily\s+IS\s+\?/);
    expect(query.sql).not.toMatch(/channelFamily\s+IS\s+NULL/);
    expect(query.params).toEqual(['rooms', 'rooms', 0, null]);
  });

  it('produces the top-level query when no channelName is provided', () => {
    const query = buildLoadReplayQuery(0, { channelFamily: null, userId: null });
    expect(query.sql).toMatch(/channel IS NULL/);
    expect(query.sql).toMatch(/channelFamily IS NULL/);
    expect(query.sql).toMatch(/userId IS NULL OR userId = \?/);
    expect(query.params).toEqual([0, null]);
  });
});

describe('ReplayFrame schema', () => {
  it('accepts a top-level replay frame with no scope markers', () => {
    const result = v.safeParse(ReplayFrame, ['__replay__', { lastKnownSeq: 5 }, null]);
    expect(result.success).toBe(true);
  });

  it('accepts a channel-scoped replay frame', () => {
    const result = v.safeParse(ReplayFrame, [
      '__replay__',
      {},
      { channel: { name: 'room', family: 'rooms' } },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects a replay frame that carries an unknown routing marker', () => {
    // The replay frame's __livething carries only known routing keys; a stray
    // unknown marker must fail validation, not be silently ignored.
    const result = v.safeParse(ReplayFrame, ['__replay__', {}, { bogus: { admin: true } }]);
    expect(result.success).toBe(false);
  });
});

describe('replay retention on an engine with a bound-parameter cap', () => {
  it('prunes the server store when many channels have a replay of their own', () => {
    const maxBoundParams = 100;
    const sql = createTestSql({
      limits: { maxBoundParams },
      onExec(_query, params) {
        if (params.length > maxBoundParams) {
          throw new Error(`too many SQL variables: ${params.length} for ${maxBoundParams}`);
        }
      },
    });
    ensureReplaySchema(sql);
    const claimedChannelKeys = new Set(
      Array.from({ length: 60 }, (_, index) => `channel-${index}`),
    );

    expect(() =>
      pruneExpiredReplayRows(sql, {
        retention: { maxAgeMs: 50 },
        now: 100,
        owner: { channelKey: undefined, claimedChannelKeys },
      }),
    ).not.toThrow();
  });

  it('deletes expired rows of many channel scopes in a few statements, and keeps claimed ones', () => {
    const maxBoundParams = 100;
    let deletes = 0;
    const sql = createTestSql({
      limits: { maxBoundParams },
      onExec(query, params) {
        if (params.length > maxBoundParams) {
          throw new Error(`too many SQL variables: ${params.length} for ${maxBoundParams}`);
        }

        if (/^\s*DELETE FROM __livething_replay\b/.test(query)) deletes += 1;
      },
    });
    ensureReplaySchema(sql);
    for (let index = 0; index < 500; index += 1) {
      sql.exec(
        `INSERT INTO __livething_replay (rowKey, messageId, seq, event, payload, channel, createdAt)
         VALUES (?, ?, ?, 'news', '{}', ?, 1)`,
        `row-${index}`,
        `m-${index}`,
        index + 1,
        `room-${index}`,
      );
    }

    pruneExpiredReplayRows(sql, {
      retention: { maxAgeMs: 50 },
      now: 100,
      owner: { channelKey: undefined, claimedChannelKeys: new Set(['room-0']) },
    });

    const left = sql.exec<{ channel: string }>('SELECT channel FROM __livething_replay').toArray();
    expect(left.map((row) => row.channel)).toEqual(['room-0']);
    expect(deletes).toBeLessThanOrEqual(20);
  });
});
