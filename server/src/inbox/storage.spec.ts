import { describe, expect, it } from 'vitest';
import {
  ackInboxRows,
  bumpInboxWatermark,
  clearInboxWatermarks,
  deleteInboxRowsForChannel,
  deleteInboxWatermarkForChannel,
  ensureInboxSchema,
  insertInboxRows,
  insertInboxRowsForIdentity,
  loadInboxWatermarks,
  loadUndeliveredRows,
  pruneInboxRetention,
} from './storage.ts';
import { createTestSql } from './test-sql.ts';
import type { InboxFrame } from './storage.ts';

function frame(seq: number, overrides: Partial<InboxFrame> = {}): InboxFrame {
  return { seq, messageId: `msg_${seq}`, event: 'message', payload: { n: seq }, ...overrides };
}

function setup() {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  return sql;
}

describe('inbox/storage — insert and load', () => {
  it('writes one row per identity sharing the frame seq and messageId', () => {
    const sql = setup();
    insertInboxRows(sql, {
      identities: ['alice', 'bob'],
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

  it('de-dupes on the (identity, channel, seq) primary key via INSERT OR REPLACE', () => {
    const sql = setup();
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(5, { payload: { n: 1 } }),
      now: 1000,
    });
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(5, { payload: { n: 2 } }),
      now: 2000,
    });

    const rows = loadUndeliveredRows(sql, 'alice');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ n: 2 });
  });

  it('orders undelivered rows by channel then family then seq', () => {
    const sql = setup();
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'beta',
      channelFamily: null,
      frame: frame(9),
      now: 1,
    });
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'alpha',
      channelFamily: null,
      frame: frame(2),
      now: 1,
    });
    insertInboxRows(sql, {
      identities: ['alice'],
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

  it('backfills one identity from full frames keeping their own seq/messageId', () => {
    const sql = setup();
    insertInboxRowsForIdentity(sql, {
      identity: 'carol',
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
      identities: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'room',
      channelFamily: 'rooms',
      frame: frame(2),
      now: 1,
    });

    const rows = loadUndeliveredRows(sql, 'alice');
    expect(rows.map((r) => r.channelFamily)).toEqual([null, 'rooms']);
  });
});

describe('inbox/storage — ack lifecycle', () => {
  function seedThree(sql: ReturnType<typeof setup>, identity = 'alice') {
    for (const seq of [1, 2, 3]) {
      insertInboxRows(sql, {
        identities: [identity],
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
      identity: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 2,
      afterDelivered: 'delete',
      now: 2000,
    });

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([3]);
  });

  it('delete mode with a lower/repeated receivedThrough is a no-op', () => {
    const sql = setup();
    seedThree(sql);
    function ack(receivedThrough: number) {
      ackInboxRows(sql, {
        identity: 'alice',
        channelName: 'room',
        channelFamily: null,
        receivedThrough,
        afterDelivered: 'delete',
        now: 2000,
      });
    }

    ack(2);
    ack(1);
    ack(2);
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([3]);
  });

  it('keep mode stamps delivered_at only on still-NULL rows and stays owed until then', () => {
    const sql = setup();
    seedThree(sql);

    ackInboxRows(sql, {
      identity: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 2,
      afterDelivered: 'keep',
      now: 2000,
    });

    // Kept rows still exist but are no longer owed (delivered_at set); seq 3 stays owed.
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([3]);
    const delivered = sql
      .exec<{
        seq: number;
        delivered_at: number;
      }>('SELECT seq, delivered_at FROM __wskit_inbox WHERE identity = ? ORDER BY seq', 'alice')
      .toArray();
    expect(delivered.map((r) => [r.seq, r.delivered_at])).toEqual([
      [1, 2000],
      [2, 2000],
      [3, null],
    ]);
  });

  it('keep mode does not clobber an earlier delivered_at on a repeated ack', () => {
    const sql = setup();
    seedThree(sql);
    function ack(now: number) {
      ackInboxRows(sql, {
        identity: 'alice',
        channelName: 'room',
        channelFamily: null,
        receivedThrough: 1,
        afterDelivered: 'keep',
        now,
      });
    }

    ack(2000);
    ack(9000);
    const first = sql
      .exec<{
        delivered_at: number;
      }>('SELECT delivered_at FROM __wskit_inbox WHERE identity = ? AND seq = 1', 'alice')
      .one();
    expect(first?.delivered_at).toBe(2000);
  });
});

describe('inbox/storage — leave clears rows and watermark', () => {
  it('deleteInboxRowsForChannel scopes to one channel only', () => {
    const sql = setup();
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: frame(1),
      now: 1,
    });
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'lobby',
      channelFamily: null,
      frame: frame(2),
      now: 1,
    });

    deleteInboxRowsForChannel(sql, { identity: 'alice', channelName: 'room', channelFamily: null });

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.channelName)).toEqual(['lobby']);
  });

  it('deleteInboxWatermarkForChannel removes only the matching scope (regression: leave leaves a stale gap)', () => {
    const sql = setup();
    bumpInboxWatermark(sql, {
      identity: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 7,
    });
    bumpInboxWatermark(sql, {
      identity: 'alice',
      channelName: 'lobby',
      channelFamily: null,
      evictedThroughSeq: 3,
    });

    deleteInboxWatermarkForChannel(sql, {
      identity: 'alice',
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
        identities: ['alice'],
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
      identity: 'alice',
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
      identity: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxAgeMs: 50 },
      now: 100,
    });

    expect(evicted).toBe(2);
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([3]);
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
      identity: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxAgeMs: 50, maxMessages: 2 },
      now: 100,
    });

    // Age drops 1,2; count keeps newest 2 (4,5) dropping 3 too. Highest evicted is 3.
    expect(evicted).toBe(3);
    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([4, 5]);
  });

  it('returns null when nothing is over the limit', () => {
    const sql = setup();
    seed(sql, [{ seq: 1, now: 90 }]);
    expect(
      pruneInboxRetention(sql, {
        identity: 'alice',
        channelName: 'room',
        channelFamily: null,
        retention: { maxAgeMs: 50, maxMessages: 5 },
        now: 100,
      }),
    ).toBeNull();
  });

  it('bumpInboxWatermark never lowers, and clearInboxWatermarks removes all for the identity', () => {
    const sql = setup();
    function bump(evictedThroughSeq: number) {
      bumpInboxWatermark(sql, {
        identity: 'alice',
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
