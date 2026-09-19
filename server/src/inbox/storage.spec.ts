import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import {
  advanceReceivedThrough,
  ensureReceiptsSchema,
  listReaders,
  listReceivers,
} from './receipts-storage.ts';
import {
  ackInboxRows,
  bumpInboxWatermark,
  clearInboxWatermarks,
  deleteInboxRowsForChannel,
  deleteInboxRowsOutsideScopes,
  deleteInboxWatermarkForChannel,
  ensureInboxSchema,
  insertInboxRows,
  insertInboxRowsForUserId,
  listExpiredInboxRetentionTargets,
  loadInboxWatermarks,
  loadUndeliveredRows,
  nextInboxRetentionAt,
  pruneInboxRetention,
  pruneInboxRetentionAndBumpWatermark,
} from './storage.ts';
import type { InboxFrame } from './storage.ts';

function frame(seq: number, overrides: Partial<InboxFrame> = {}): InboxFrame {
  return {
    deliverySeq: seq,
    messageId: `msg_${seq}`,
    event: 'message',
    payload: { n: seq },
    ...overrides,
  };
}

function setup() {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  ensureReceiptsSchema(sql);
  return sql;
}

describe('inbox/storage — insert and load', () => {
  it('writes one row per user id sharing the frame seq and messageId', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice', 'bob'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(5),
      now: 1000,
    });

    expect(loadUndeliveredRows(sql, 'alice')).toEqual([
      {
        seq: 5,
        messageId: 'msg_5',
        event: 'message',
        payload: JSON.stringify({ n: 5 }),
        channelName: 'room',
        channelFamily: null,
      },
    ]);
    expect(loadUndeliveredRows(sql, 'bob')[0]?.seq).toBe(5);
  });

  it('a re-insert on the (user_id, channel, seq) primary key is a no-op, not a replace', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(5, { payload: { n: 1 } }),
      now: 1000,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(5, { payload: { n: 2 } }),
      now: 2000,
    });

    const rows = loadUndeliveredRows(sql, 'alice');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ n: 1 });
  });

  it('a duplicate insert never makes an acknowledged row unread', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(5),
      now: 1000,
    });
    ackInboxRows(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 5,
      onDelivered: 'retain',
      now: 2000,
    });

    // The same message arrives again — the import ran twice, or the frame is re-fanned-out.
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(5),
      now: 3000,
    });

    const row = sql
      .exec<{
        delivered_at: number | null;
      }>('SELECT delivered_at FROM __livething_inbox WHERE user_id = ? AND seq = 5', 'alice')
      .one();
    expect(row?.delivered_at).toBe(2000);
    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
  });

  it('orders undelivered rows by channel then family then seq', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'beta',
      channelFamily: null,
      frame: frame(9),
      now: 1,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'alpha',
      channelFamily: null,
      frame: frame(2),
      now: 1,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'alpha',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });

    expect(loadUndeliveredRows(sql, 'alice').map((r) => [r.channelName, r.seq])).toEqual([
      ['alpha', 1],
      ['alpha', 2],
      ['beta', 9],
    ]);
  });

  it('backfills one user id from full frames keeping their own seq/messageId', () => {
    const sql = setup();
    insertInboxRowsForUserId(sql, {
      userId: 'carol',
      channelName: 'room',
      channelFamily: 'tenants',
      frames: [frame(3), frame(7)],
      now: 1000,
    });

    expect(loadUndeliveredRows(sql, 'carol').map((r) => r.seq)).toEqual([3, 7]);
    expect(loadUndeliveredRows(sql, 'carol')[0]?.channelFamily).toBe('tenants');
  });

  it('keys a static channel under an empty family and a family channel under its key', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: 'rooms',
      frame: frame(2),
      now: 1,
    });

    const rows = loadUndeliveredRows(sql, 'alice');
    expect(rows.map((r) => r.channelFamily)).toEqual([null, 'rooms']);
  });
});

describe('inbox/storage — bind-limit batching', () => {
  // 8 bound params per row: userId, channelName, family, seq, messageId, event, payload, created_at.
  function limitedSql(maxBoundParams: number) {
    const sql = createTestSql({ limits: { maxBoundParams } });
    ensureInboxSchema(sql);
    return sql;
  }

  it('insertInboxRows writes every row when the member count is under one batch', () => {
    const sql = limitedSql(32); // room for 4 rows (32 / 8)
    const userIds = ['a', 'b', 'c'];
    insertInboxRows(sql, {
      userIds,
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });

    for (const userId of userIds) {
      expect(loadUndeliveredRows(sql, userId)).toHaveLength(1);
    }
  });

  it('insertInboxRows writes every row when the member count lands exactly on one batch', () => {
    const sql = limitedSql(32); // exactly 4 rows fit in one batch
    const userIds = ['a', 'b', 'c', 'd'];
    insertInboxRows(sql, {
      userIds,
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });

    for (const userId of userIds) {
      expect(loadUndeliveredRows(sql, userId)).toHaveLength(1);
    }
  });

  it('insertInboxRows still writes every row when the member count spans several batches', () => {
    const sql = limitedSql(32); // 4 rows per batch, 5 members needs 2 batches
    const userIds = ['a', 'b', 'c', 'd', 'e'];
    insertInboxRows(sql, {
      userIds,
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });

    for (const userId of userIds) {
      expect(loadUndeliveredRows(sql, userId)).toHaveLength(1);
    }
  });

  it('insertInboxRowsForUserId batches a large backfill across several statements', () => {
    const sql = limitedSql(32); // 4 frames per batch, 5 frames needs 2 batches
    const frames = [1, 2, 3, 4, 5].map((seq) => frame(seq));
    insertInboxRowsForUserId(sql, {
      userId: 'carol',
      channelName: 'room',
      channelFamily: null,
      frames,
      now: 1,
    });

    expect(loadUndeliveredRows(sql, 'carol').map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('insertInboxRows is atomic across batches: a mid-run failure leaves no partial rows', () => {
    let insertCalls = 0;
    const sql = createTestSql({
      limits: { maxBoundParams: 32 }, // 4 rows per batch, 5 members needs 2 batches
      onExec: (query) => {
        if (!query.trim().startsWith('INSERT')) return;

        insertCalls += 1;
        if (insertCalls === 2) throw new Error('storage down mid-transaction');
      },
    });
    ensureInboxSchema(sql);

    expect(() =>
      insertInboxRows(sql, {
        userIds: ['a', 'b', 'c', 'd', 'e'],
        channelName: 'room',
        channelFamily: null,
        frame: frame(1),
        now: 1,
      }),
    ).toThrow('storage down mid-transaction');

    for (const userId of ['a', 'b', 'c', 'd', 'e']) {
      expect(loadUndeliveredRows(sql, userId)).toEqual([]);
    }
  });
});

describe('inbox/storage — ack lifecycle', () => {
  function seedThree(sql: ReturnType<typeof setup>, userId = 'alice') {
    for (const seq of [1, 2, 3]) {
      insertInboxRows(sql, {
        userIds: [userId],
        channelName: 'room',
        channelFamily: null,
        frame: frame(seq),
        now: 1000,
      });
    }
  }

  it('delete mode drops rows up to receivedThrough', () => {
    const sql = setup();
    seedThree(sql);

    ackInboxRows(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 2,
      onDelivered: 'delete',
      now: 2000,
    });

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([3]);
  });

  it('delete mode with a lower/repeated receivedThrough is a no-op', () => {
    const sql = setup();
    seedThree(sql);
    function ack(receivedThrough: number) {
      ackInboxRows(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        receivedThrough,
        onDelivered: 'delete',
        now: 2000,
      });
    }

    ack(2);
    ack(1);
    ack(2);
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([3]);
  });

  it('retain mode stamps delivered_at only on still-NULL rows and stays owed until then', () => {
    const sql = setup();
    seedThree(sql);

    ackInboxRows(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 2,
      onDelivered: 'retain',
      now: 2000,
    });

    // Kept rows still exist but are no longer owed (delivered_at set); seq 3 stays owed.
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([3]);
    const delivered = sql
      .exec<{
        seq: number;
        delivered_at: number;
      }>('SELECT seq, delivered_at FROM __livething_inbox WHERE user_id = ? ORDER BY seq', 'alice')
      .toArray();
    expect(delivered.map((r) => [r.seq, r.delivered_at])).toEqual([
      [1, 2000],
      [2, 2000],
      [3, null],
    ]);
  });

  it('retain mode does not clobber an earlier delivered_at on a repeated ack', () => {
    const sql = setup();
    seedThree(sql);
    function ack(now: number) {
      ackInboxRows(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        receivedThrough: 1,
        onDelivered: 'retain',
        now,
      });
    }

    ack(2000);
    ack(9000);
    const first = sql
      .exec<{
        delivered_at: number;
      }>('SELECT delivered_at FROM __livething_inbox WHERE user_id = ? AND seq = 1', 'alice')
      .one();
    expect(first?.delivered_at).toBe(2000);
  });
});

describe('inbox/storage — leave clears rows and watermark', () => {
  it('deleteInboxRowsForChannel scopes to one channel only', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'lobby',
      channelFamily: null,
      frame: frame(2),
      now: 1,
    });

    deleteInboxRowsForChannel(sql, { userId: 'alice', channelName: 'room', channelFamily: null });

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.channelName)).toEqual(['lobby']);
  });

  it('deleteInboxWatermarkForChannel removes only the matching scope', () => {
    const sql = setup();
    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 7,
    });
    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'lobby',
      channelFamily: null,
      evictedThroughSeq: 3,
    });
    advanceReceivedThrough(sql, {
      channelName: 'old-chat',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 3,
      now: 10,
    });

    deleteInboxWatermarkForChannel(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
    });

    expect(loadInboxWatermarks(sql, 'alice')).toEqual([
      { channelName: 'lobby', channelFamily: null, evictedThroughSeq: 3 },
    ]);
  });
});

describe('inbox/storage — retention and watermark', () => {
  function seed(sql: ReturnType<typeof setup>, entries: Array<{ seq: number; now: number }>) {
    for (const { seq, now } of entries) {
      insertInboxRows(sql, {
        userIds: ['alice'],
        channelName: 'room',
        channelFamily: null,
        frame: frame(seq),
        now,
      });
    }
  }

  it('maxMessages keeps the newest N and returns the highest evicted seq', () => {
    const sql = setup();
    seed(
      sql,
      [1, 2, 3, 4, 5].map((seq) => ({ seq, now: seq })),
    );

    const evicted = pruneInboxRetention(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxMessages: 2 },
      now: 100,
    });

    expect(evicted).toBe(3);
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([4, 5]);
  });

  it('maxAgeMs evicts by created_at cutoff and returns the highest evicted seq', () => {
    const sql = setup();
    seed(sql, [
      { seq: 1, now: 10 },
      { seq: 2, now: 20 },
      { seq: 3, now: 90 },
    ]);

    const evicted = pruneInboxRetention(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxAgeMs: 50 },
      now: 100,
    });

    expect(evicted).toBe(2);
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([3]);
  });

  it('finds the first age deadline and skips the exact cutoff millisecond', () => {
    const sql = setup();
    seed(sql, [
      { seq: 1, now: 10 },
      { seq: 2, now: 20 },
      { seq: 3, now: 90 },
    ]);

    expect(nextInboxRetentionAt(sql, { channelKey: 'room', maxAgeMs: 50 })).toBe(61);
  });

  it('finds expired member scopes for both static channels and dynamic families', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 10,
    });
    insertInboxRows(sql, {
      userIds: ['bob'],
      channelName: 'room:one',
      channelFamily: 'rooms',
      frame: frame(2),
      now: 20,
    });

    expect(
      listExpiredInboxRetentionTargets(sql, { channelKey: 'room', maxAgeMs: 50, now: 100 }),
    ).toEqual([{ userId: 'alice', channelName: 'room', channelFamily: null }]);
    expect(
      listExpiredInboxRetentionTargets(sql, { channelKey: 'rooms', maxAgeMs: 50, now: 100 }),
    ).toEqual([{ userId: 'bob', channelName: 'room:one', channelFamily: 'rooms' }]);
  });

  it('deletes rows and watermarks for scopes removed by a deployment', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'chat',
      channelFamily: null,
      frame: frame(1),
      now: 10,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room:one',
      channelFamily: 'rooms',
      frame: frame(2),
      now: 10,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'old-chat',
      channelFamily: null,
      frame: frame(3),
      now: 10,
    });
    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'old-chat',
      channelFamily: null,
      evictedThroughSeq: 3,
    });

    deleteInboxRowsOutsideScopes(sql, { staticNames: ['chat'], familyKeys: ['rooms'] });

    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([1, 2]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
    expect(listReceivers(sql, { channelName: 'old-chat', channelFamily: null, seq: 1 })).toEqual(
      [],
    );
  });

  it('deletes a stale scope that exists only in receipts', () => {
    const sql = setup();
    advanceReceivedThrough(sql, {
      channelName: 'old-chat',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 3,
      now: 10,
    });
    sql.exec(
      'UPDATE __livething_inbox_receipts SET read_through = ? WHERE channel_name = ?',
      3,
      'old-chat',
    );

    deleteInboxRowsOutsideScopes(sql, { staticNames: ['chat'], familyKeys: [] });

    expect(listReceivers(sql, { channelName: 'old-chat', channelFamily: null, seq: 1 })).toEqual(
      [],
    );
    expect(listReaders(sql, { channelName: 'old-chat', channelFamily: null, seq: 1 })).toEqual([]);
  });

  it('rolls back stale-scope deletion across inbox, watermarks, and receipts', () => {
    let fail = true;
    const sql = createTestSql({
      onExec(query) {
        if (fail && query.includes('DELETE FROM __livething_inbox_watermark')) {
          fail = false;
          throw new Error('injected reconcile failure');
        }
      },
    });
    ensureInboxSchema(sql);
    ensureReceiptsSchema(sql);
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'old-chat',
      channelFamily: null,
      frame: frame(1),
      now: 10,
    });

    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'old-chat',
      channelFamily: null,
      evictedThroughSeq: 1,
    });
    advanceReceivedThrough(sql, {
      channelName: 'old-chat',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 1,
      now: 10,
    });

    expect(() => deleteInboxRowsOutsideScopes(sql, { staticNames: [], familyKeys: [] })).toThrow(
      'injected reconcile failure',
    );
    expect(loadUndeliveredRows(sql, 'alice')).toHaveLength(1);
    expect(loadInboxWatermarks(sql, 'alice')).toHaveLength(1);
    expect(listReceivers(sql, { channelName: 'old-chat', channelFamily: null, seq: 1 })).toEqual([
      'alice',
    ]);
  });

  it('both limits together return the highest evicted seq across the two', () => {
    const sql = setup();
    seed(sql, [
      { seq: 1, now: 10 },
      { seq: 2, now: 20 },
      { seq: 3, now: 95 },
      { seq: 4, now: 96 },
      { seq: 5, now: 97 },
    ]);

    const evicted = pruneInboxRetention(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxAgeMs: 50, maxMessages: 2 },
      now: 100,
    });

    // Age drops 1,2; count keeps newest 2 (4,5) dropping 3 too. Highest evicted is 3.
    expect(evicted).toBe(3);
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([4, 5]);
  });

  it('eviction and its overflow watermark commit together for mixed delivered and undelivered rows', () => {
    const sql = setup();
    seed(
      sql,
      [1, 2, 3].map((seq) => ({ seq, now: seq })),
    );
    ackInboxRows(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 1,
      onDelivered: 'retain',
      now: 10,
    });

    const evicted = pruneInboxRetentionAndBumpWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxMessages: 1 },
      now: 100,
    });

    expect(evicted).toBe(2);
    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([3]);
    expect(
      sql
        .exec<{
          delivered_at: number | null;
        }>('SELECT delivered_at FROM __livething_inbox WHERE user_id = ? AND seq = ?', 'alice', 3)
        .one()?.delivered_at,
    ).toBeNull();
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 2 },
    ]);
  });

  it('does not raise a gap when retention removes only delivered rows', () => {
    const sql = setup();
    seed(sql, [{ seq: 1, now: 10 }]);
    ackInboxRows(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 1,
      onDelivered: 'retain',
      now: 20,
    });

    expect(
      pruneInboxRetentionAndBumpWatermark(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        retention: { maxAgeMs: 50 },
        now: 100,
      }),
    ).toBe(1);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });

  it('does not raise a gap when maxMessages evicts only delivered rows', () => {
    const sql = setup();
    seed(
      sql,
      [1, 2, 3].map((seq) => ({ seq, now: seq })),
    );
    ackInboxRows(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 3,
      onDelivered: 'retain',
      now: 10,
    });

    expect(
      pruneInboxRetentionAndBumpWatermark(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        retention: { maxMessages: 1 },
        now: 100,
      }),
    ).toBe(2);
    expect(
      sql
        .exec<{
          seq: number;
          delivered_at: number | null;
        }>('SELECT seq, delivered_at FROM __livething_inbox ORDER BY seq')
        .toArray(),
    ).toEqual([{ seq: 3, delivered_at: 10 }]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });

  it('does not raise a gap when combined retention ages out only a delivered row', () => {
    const sql = setup();
    seed(sql, [
      { seq: 1, now: 10 },
      { seq: 2, now: 90 },
      { seq: 3, now: 95 },
    ]);
    ackInboxRows(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 1,
      onDelivered: 'retain',
      now: 20,
    });

    expect(
      pruneInboxRetentionAndBumpWatermark(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        retention: { maxAgeMs: 50, maxMessages: 2 },
        now: 100,
      }),
    ).toBe(1);
    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([2, 3]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });

  it('raises a watermark only through the highest evicted undelivered row', () => {
    const sql = setup();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(2),
      now: 2,
    });
    ackInboxRows(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 2,
      onDelivered: 'retain',
      now: 10,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(3),
      now: 3,
    });

    expect(
      pruneInboxRetentionAndBumpWatermark(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        retention: { maxMessages: 1 },
        now: 100,
      }),
    ).toBe(2);
    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([3]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 1 },
    ]);
  });

  it('merges overflow watermarks across repeated pruning passes', () => {
    const sql = setup();
    seed(
      sql,
      [1, 2, 3].map((seq) => ({ seq, now: seq })),
    );

    pruneInboxRetentionAndBumpWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxMessages: 1 },
      now: 100,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(4),
      now: 4,
    });
    pruneInboxRetentionAndBumpWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxMessages: 1 },
      now: 200,
    });

    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([4]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 3 },
    ]);
  });

  it('rolls back evictions when writing the overflow watermark fails', () => {
    const sql = createTestSql({
      onExec(query) {
        if (query.includes('INSERT OR REPLACE INTO __livething_inbox_watermark')) {
          throw new Error('injected watermark failure');
        }
      },
    });
    ensureInboxSchema(sql);
    seed(
      sql,
      [1, 2, 3].map((seq) => ({ seq, now: seq })),
    );

    expect(() =>
      pruneInboxRetentionAndBumpWatermark(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        retention: { maxMessages: 1 },
        now: 100,
      }),
    ).toThrow('injected watermark failure');

    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });

  it('returns null when nothing is over the limit', () => {
    const sql = setup();
    seed(sql, [{ seq: 1, now: 90 }]);
    expect(
      pruneInboxRetention(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        retention: { maxAgeMs: 50, maxMessages: 5 },
        now: 100,
      }),
    ).toBeNull();
  });

  it('bumpInboxWatermark never lowers, and clearInboxWatermarks removes all for the user id', () => {
    const sql = setup();
    function bump(evictedThroughSeq: number) {
      bumpInboxWatermark(sql, {
        userId: 'alice',
        channelName: 'room',
        channelFamily: null,
        evictedThroughSeq,
      });
    }

    bump(10);
    bump(4);
    expect(loadInboxWatermarks(sql, 'alice')[0]?.evictedThroughSeq).toBe(10);
    bump(20);
    expect(loadInboxWatermarks(sql, 'alice')[0]?.evictedThroughSeq).toBe(20);

    clearInboxWatermarks(sql, 'alice');
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });
});
