import * as Wire from '~/_engine/runtime/wire.ts';
import { createTestSql } from '~/_test/sql.ts';
import { ensureMembershipSchema, insertMembership } from '~/channel/storage.ts';
import { ensureSequenceSchema } from '~/sequence/runtime.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { ResolvedInboxOptions } from '~/_engine/runtime/feature-slots.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import {
  applyInboxAck,
  backfillInbox,
  clearInboxForChannel,
  drainInboxOnReconnect,
  fanOutToInbox,
  memberCountKey,
  nextInboxRetentionDeadline,
  scopeMatchesChannel,
  sweepInboxRetention,
} from './runtime.ts';
import {
  bumpInboxWatermark,
  ensureInboxSchema,
  insertInboxRows,
  loadInboxWatermarks,
  loadUndeliveredRows,
  pruneInboxRetentionAndBumpWatermark,
} from './storage.ts';

function createCore(
  inboxChannels: Map<string, ResolvedInboxOptions> = new Map(),
  sql = createTestSql(),
) {
  ensureInboxSchema(sql);
  ensureMembershipSchema(sql);
  ensureSequenceSchema(sql);
  let idCounter = 0;
  const core = {
    inboxChannels,
    inboxMemberCounts: new Map<string, number>(),
    alarmSources: new Map<symbol, () => number | null>(),
    timers: { setAlarm: vi.fn(), deleteAlarm: vi.fn() },
    storage: { sql },
    generateId: (prefix = 'id') => `${prefix}_${++idCounter}`,
  } as unknown as EngineCore;

  return { core, sql };
}

function connection(userId: string | null): RuntimeConnection {
  return { userId } as unknown as RuntimeConnection;
}

const deliver: ResolvedInboxOptions = {
  broadcastReceipts: false,
  maxReceiptAudience: 256,
};

afterEach(() => vi.restoreAllMocks());

describe('scopeMatchesChannel', () => {
  it('does not match a plain channel key against a family scope that shares its concrete name', () => {
    // A family 'rooms' lets a client pick the concrete name 'alpha', which can
    // collide with an unrelated plain channel also named 'alpha'.
    const scope = { channelName: 'alpha', channelFamily: 'rooms' };
    expect(scopeMatchesChannel(scope, 'alpha')).toBe(false);
  });

  it('matches a family scope by its family key', () => {
    const scope = { channelName: 'alpha', channelFamily: 'rooms' };
    expect(scopeMatchesChannel(scope, 'rooms')).toBe(true);
  });

  it('still matches a plain channel scope by its channel name', () => {
    const scope = { channelName: 'alpha', channelFamily: null };
    expect(scopeMatchesChannel(scope, 'alpha')).toBe(true);
  });
});

describe('memberCountKey', () => {
  it('gives distinct channel/family pairs distinct keys', () => {
    const keyA = memberCountKey('a', 'b c', 'u');
    const keyB = memberCountKey('a b', 'c', 'u');
    expect(keyA).not.toBe(keyB);
  });
});

describe('fanOutToInbox', () => {
  it('writes nothing for a non-inbox channel', () => {
    const { core, sql } = createCore();
    insertMembership(sql, { userId: 'alice', channelName: 'room', channelFamily: null });

    fanOutToInbox(core, {
      channelName: 'room',
      channelFamily: null,
      event: 'msg',
      payload: { text: 'hi' },
      deliverySeq: 1,
      messageId: 'm1',
    });

    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
  });

  it('writes one row per durable member sharing the given seq/messageId', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertMembership(sql, { userId: 'alice', channelName: 'room', channelFamily: null });
    insertMembership(sql, { userId: 'bob', channelName: 'room', channelFamily: null });

    fanOutToInbox(core, {
      channelName: 'room',
      channelFamily: null,
      event: 'msg',
      payload: { text: 'hi' },
      deliverySeq: 42,
      messageId: 'msg_1',
    });

    expect(loadUndeliveredRows(sql, 'alice')[0]?.seq).toBe(42);
    expect(loadUndeliveredRows(sql, 'alice')[0]?.messageId).toBe('msg_1');
    expect(loadUndeliveredRows(sql, 'bob')[0]?.seq).toBe(42);
    expect(loadUndeliveredRows(sql, 'bob')[0]?.messageId).toBe('msg_1');
  });

  it('filters out anonymous members but still writes durable rows', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertMembership(sql, { userId: 'alice', channelName: 'room', channelFamily: null });
    insertMembership(sql, { userId: '', channelName: 'room', channelFamily: null });

    fanOutToInbox(core, {
      channelName: 'room',
      channelFamily: null,
      event: 'msg',
      payload: {},
      deliverySeq: 1,
      messageId: 'm1',
    });

    expect(loadUndeliveredRows(sql, '')).toEqual([]);
    expect(loadUndeliveredRows(sql, 'alice')).toHaveLength(1);
  });

  it('inserts nothing when a channel has zero durable members', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));

    fanOutToInbox(core, {
      channelName: 'room',
      channelFamily: null,
      event: 'msg',
      payload: {},
      deliverySeq: 1,
      messageId: 'm1',
    });

    expect(sql.exec('SELECT COUNT(*) AS c FROM __livething_inbox').one() as { c: number }).toEqual({
      c: 0,
    });
  });

  it('excludeUserId skips that member entirely', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertMembership(sql, { userId: 'alice', channelName: 'room', channelFamily: null });
    insertMembership(sql, { userId: 'bob', channelName: 'room', channelFamily: null });

    fanOutToInbox(core, {
      channelName: 'room',
      channelFamily: null,
      event: 'msg',
      payload: { text: 'hi' },
      deliverySeq: 1,
      messageId: 'm1',
      excludeUserId: 'alice',
    });

    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
    expect(loadUndeliveredRows(sql, 'bob')).toHaveLength(1);
  });

  it('resolves a family channel by its family key', () => {
    const { core, sql } = createCore(new Map([['rooms', deliver]]));
    insertMembership(sql, { userId: 'alice', channelName: 'room-1', channelFamily: 'rooms' });

    fanOutToInbox(core, {
      channelName: 'room-1',
      channelFamily: 'rooms',
      event: 'msg',
      payload: {},
      deliverySeq: 1,
      messageId: 'm1',
    });

    expect(loadUndeliveredRows(sql, 'alice')[0]?.channelFamily).toBe('rooms');
  });

  it('rolls back retention deletes when the overflow watermark cannot be written', () => {
    const sql = createTestSql({
      onExec(query) {
        if (query.includes('INSERT OR REPLACE INTO __livething_inbox_watermark')) {
          throw new Error('injected watermark failure');
        }
      },
    });
    const core = createCore(
      new Map([['room', { ...deliver, retention: { maxMessages: 1 } }]]),
      sql,
    ).core;
    insertMembership(sql, { userId: 'alice', channelName: 'room', channelFamily: null });

    fanOutToInbox(core, {
      channelName: 'room',
      channelFamily: null,
      event: 'msg',
      payload: { n: 1 },
      deliverySeq: 1,
      messageId: 'm1',
    });

    expect(() =>
      fanOutToInbox(core, {
        channelName: 'room',
        channelFamily: null,
        event: 'msg',
        payload: { n: 2 },
        deliverySeq: 2,
        messageId: 'm2',
      }),
    ).toThrow('injected watermark failure');

    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([1, 2]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });

  it('does not raise a watermark when the fan-out queue stays within its cap', () => {
    const { core, sql } = createCore(
      new Map([['room', { ...deliver, retention: { maxMessages: 2 } }]]),
    );
    insertMembership(sql, { userId: 'alice', channelName: 'room', channelFamily: null });

    for (const seq of [1, 2]) {
      fanOutToInbox(core, {
        channelName: 'room',
        channelFamily: null,
        event: 'msg',
        payload: { seq },
        deliverySeq: seq,
        messageId: `m${seq}`,
      });
    }

    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([1, 2]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });

  it('arms the shared alarm when an age-retained row is inserted', () => {
    const timers = { setAlarm: vi.fn(), deleteAlarm: vi.fn() };
    const { core, sql } = createCore(
      new Map([['room', { ...deliver, retention: { maxAgeMs: 50 } }]]),
    );
    Object.assign(core, { timers });
    core.alarmSources.set(Symbol('test'), () => Date.now() + 51);
    insertMembership(sql, { userId: 'alice', channelName: 'room', channelFamily: null });

    fanOutToInbox(core, {
      channelName: 'room',
      channelFamily: null,
      event: 'msg',
      payload: {},
      deliverySeq: 1,
      messageId: 'm1',
    });

    expect(timers.setAlarm).toHaveBeenCalledTimes(1);
    expect(timers.setAlarm.mock.calls[0]?.[0]).toBeGreaterThan(Date.now());
  });
});

describe('quiet inbox retention sweep', () => {
  it('removes expired undelivered rows and raises a gap watermark', () => {
    const { sql } = createCore();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { deliverySeq: 1, messageId: 'm1', event: 'msg', payload: {} },
      now: 10,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { deliverySeq: 2, messageId: 'm2', event: 'msg', payload: {} },
      now: 90,
    });

    expect(
      sweepInboxRetention(sql, {
        channelKey: 'room',
        retention: { maxAgeMs: 50 },
        now: 100,
      }),
    ).toBe(1);
    expect(loadUndeliveredRows(sql, 'alice').map((row) => row.seq)).toEqual([2]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 1 },
    ]);
    expect(nextInboxRetentionDeadline(sql, { channelKey: 'room', maxAgeMs: 50 })).toBe(141);
  });

  it('is idempotent after the first sweep', () => {
    const { sql } = createCore();
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { deliverySeq: 1, messageId: 'm1', event: 'msg', payload: {} },
      now: 10,
    });

    const params = { channelKey: 'room', retention: { maxAgeMs: 50 }, now: 100 } as const;
    expect(sweepInboxRetention(sql, params)).toBe(1);
    expect(sweepInboxRetention(sql, params)).toBe(0);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 1 },
    ]);
  });
});

describe('drainInboxOnReconnect', () => {
  it('is a no-op for a connection with no user id', () => {
    const { core } = createCore();
    const gap = vi.spyOn(Wire, 'sendGap').mockImplementation(() => {});
    const replay = vi.spyOn(Wire, 'sendReplay').mockImplementation(() => {});

    drainInboxOnReconnect(core, connection(null));

    expect(gap).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('emits every watermark gap BEFORE any replay row, retaining the watermark until ack', () => {
    const { core, sql } = createCore();
    const calls: string[] = [];
    vi.spyOn(Wire, 'sendGap').mockImplementation((_c, _conn, opts) =>
      calls.push(`gap:${opts.channelName}:${opts.missedThrough}`),
    );
    vi.spyOn(Wire, 'sendReplay').mockImplementation((_c, _conn, opts) =>
      calls.push(`row:${opts.channelName}:${opts.wire.deliverySeq}`),
    );

    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 7,
    });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { deliverySeq: 8, messageId: 'm8', event: 'msg', payload: {} },
      now: 1,
    });

    drainInboxOnReconnect(core, connection('alice'));

    expect(calls).toEqual(['gap:room:7', 'row:room:8']);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 7 },
    ]);
  });

  it('emits a gap even when there are zero undelivered rows behind it', () => {
    const { core, sql } = createCore();
    const gap = vi.spyOn(Wire, 'sendGap').mockImplementation(() => {});
    vi.spyOn(Wire, 'sendReplay').mockImplementation(() => {});

    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 4,
    });

    drainInboxOnReconnect(core, connection('alice'));

    expect(gap).toHaveBeenCalledTimes(1);
    expect(gap.mock.calls[0]![2]).toMatchObject({ channelName: 'room', missedThrough: 4 });
  });

  it('replays undelivered rows in channel then seq order without a gap when no watermark exists', () => {
    const { core, sql } = createCore();
    const gap = vi.spyOn(Wire, 'sendGap').mockImplementation(() => {});
    const seqs: number[] = [];
    vi.spyOn(Wire, 'sendReplay').mockImplementation((_c, _conn, opts) => {
      seqs.push(opts.wire.deliverySeq);
    });

    for (const seq of [3, 1, 2]) {
      insertInboxRows(sql, {
        userIds: ['alice'],
        channelName: 'room',
        channelFamily: null,
        frame: { deliverySeq: seq, messageId: `m${seq}`, event: 'msg', payload: {} },
        now: 1,
      });
    }

    drainInboxOnReconnect(core, connection('alice'));

    expect(gap).not.toHaveBeenCalled();
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('stops reconnect delivery after a frame closes the connection', () => {
    const { core, sql } = createCore();
    const reconnecting = connection('alice');
    const seqs: number[] = [];
    vi.spyOn(Wire, 'sendReplay').mockImplementation((_core, target, opts) => {
      seqs.push(opts.wire.deliverySeq);
      target.closing = true;
    });

    for (const seq of [1, 2]) {
      insertInboxRows(sql, {
        userIds: ['alice'],
        channelName: 'room',
        channelFamily: null,
        frame: { deliverySeq: seq, messageId: `m${seq}`, event: 'msg', payload: {} },
        now: seq,
      });
    }

    drainInboxOnReconnect(core, reconnecting);

    expect(seqs).toEqual([1]);
  });

  it('sends the gap again on a later reconnect when the member never acknowledged it', () => {
    const { core, sql } = createCore();
    const gaps: string[] = [];
    vi.spyOn(Wire, 'sendGap').mockImplementation((_c, _conn, opts) =>
      gaps.push(`${opts.channelName}:${opts.missedThrough}`),
    );
    vi.spyOn(Wire, 'sendReplay').mockImplementation(() => {});

    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 7,
    });

    drainInboxOnReconnect(core, connection('alice'));
    drainInboxOnReconnect(core, connection('alice'));

    expect(gaps).toEqual(['room:7', 'room:7']);
  });

  it('drains the latest gap after repeated retention pruning', () => {
    const { core, sql } = createCore();
    for (const seq of [1, 2, 3]) {
      insertInboxRows(sql, {
        userIds: ['alice'],
        channelName: 'room',
        channelFamily: null,
        frame: { deliverySeq: seq, messageId: `m${seq}`, event: 'msg', payload: {} },
        now: seq,
      });
    }

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
      frame: { deliverySeq: 4, messageId: 'm4', event: 'msg', payload: {} },
      now: 4,
    });
    pruneInboxRetentionAndBumpWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      retention: { maxMessages: 1 },
      now: 200,
    });

    const calls: string[] = [];
    vi.spyOn(Wire, 'sendGap').mockImplementation((_c, _conn, opts) =>
      calls.push(`gap:${opts.channelName}:${opts.missedThrough}`),
    );
    vi.spyOn(Wire, 'sendReplay').mockImplementation((_c, _conn, opts) =>
      calls.push(`row:${opts.channelName}:${opts.wire.deliverySeq}`),
    );

    drainInboxOnReconnect(core, connection('alice'));

    expect(calls).toEqual(['gap:room:3', 'row:room:4']);
  });

  it('does not repeat the gap once the member has acknowledged past the evicted sequence', () => {
    const { core, sql } = createCore();
    const gaps: string[] = [];
    vi.spyOn(Wire, 'sendGap').mockImplementation((_c, _conn, opts) =>
      gaps.push(`${opts.channelName}:${opts.missedThrough}`),
    );
    vi.spyOn(Wire, 'sendReplay').mockImplementation(() => {});

    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 7,
    });

    applyInboxAck(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      receivedThrough: 7,
    });

    drainInboxOnReconnect(core, connection('alice'));

    expect(gaps).toEqual([]);
  });
});

describe('clearInboxForChannel', () => {
  it('drops the user id rows AND the overflow watermark for the left channel only', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    core.inboxMemberCounts.set(memberCountKey('room', null, 'alice'), 1);
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { deliverySeq: 1, messageId: 'm1', event: 'msg', payload: {} },
      now: 1,
    });
    bumpInboxWatermark(sql, {
      userId: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 5,
    });

    clearInboxForChannel(core, { userId: 'alice', channelName: 'room', channelFamily: null });

    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
    expect(core.inboxMemberCounts.has(memberCountKey('room', null, 'alice'))).toBe(false);
  });

  it('is a no-op for an anonymous user id or a non-inbox channel', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'lobby',
      channelFamily: null,
      frame: { deliverySeq: 1, messageId: 'm1', event: 'msg', payload: {} },
      now: 1,
    });

    clearInboxForChannel(core, { userId: '', channelName: 'room', channelFamily: null });
    clearInboxForChannel(core, { userId: 'alice', channelName: 'lobby', channelFamily: null });

    expect(loadUndeliveredRows(sql, 'alice')).toHaveLength(1);
  });
});

describe('backfillInbox', () => {
  it('seeds one user id from full frames and ignores an anonymous user id', () => {
    const { sql } = createCore();
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'newcomer',
      frames: [
        { deliverySeq: 1, messageId: 'm1', event: 'msg', payload: { n: 1 } },
        { deliverySeq: 2, messageId: 'm2', event: 'msg', payload: { n: 2 } },
      ],
    });
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: '',
      frames: [{ deliverySeq: 9, messageId: 'm9', event: 'msg', payload: {} }],
    });

    expect(loadUndeliveredRows(sql, 'newcomer').map((r) => r.seq)).toEqual([1, 2]);
    expect(loadUndeliveredRows(sql, '')).toEqual([]);
  });

  it('does nothing when no retention policy is provided', () => {
    const { sql } = createCore();
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'newcomer',
      frames: [1, 2, 3, 4, 5].map((seq) => ({
        deliverySeq: seq,
        messageId: `m${seq}`,
        event: 'msg',
        payload: {},
      })),
    });

    expect(loadUndeliveredRows(sql, 'newcomer')).toHaveLength(5);
  });

  it('applies maxMessages retention to the inserted rows, same as a live fan-out would', () => {
    const { sql } = createCore();
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'newcomer',
      frames: [1, 2, 3, 4, 5].map((seq) => ({
        deliverySeq: seq,
        messageId: `m${seq}`,
        event: 'msg',
        payload: {},
      })),
      retention: { maxMessages: 2 },
    });

    expect(loadUndeliveredRows(sql, 'newcomer').map((r) => r.seq)).toEqual([4, 5]);
  });

  it('raises the overflow watermark when retention evicts rows, so the next drain emits a gap', () => {
    const { sql } = createCore();
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'newcomer',
      frames: [1, 2, 3].map((seq) => ({
        deliverySeq: seq,
        messageId: `m${seq}`,
        event: 'msg',
        payload: {},
      })),
      retention: { maxMessages: 1 },
    });

    expect(loadInboxWatermarks(sql, 'newcomer')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 2 },
    ]);
  });

  it('rolls back backfill retention deletes when the overflow watermark cannot be written', () => {
    const sql = createTestSql({
      onExec(query) {
        if (query.includes('INSERT OR REPLACE INTO __livething_inbox_watermark')) {
          throw new Error('injected watermark failure');
        }
      },
    });
    createCore(new Map(), sql);

    expect(() =>
      backfillInbox(sql, {
        channelName: 'room',
        channelFamily: null,
        userId: 'newcomer',
        frames: [1, 2].map((seq) => ({
          deliverySeq: seq,
          messageId: `m${seq}`,
          event: 'msg',
          payload: {},
        })),
        retention: { maxMessages: 1 },
      }),
    ).toThrow('injected watermark failure');

    expect(loadUndeliveredRows(sql, 'newcomer').map((row) => row.seq)).toEqual([1, 2]);
    expect(loadInboxWatermarks(sql, 'newcomer')).toEqual([]);
  });

  it('retention already satisfied by the backfill leaves no watermark', () => {
    const { sql } = createCore();
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'newcomer',
      frames: [{ deliverySeq: 1, messageId: 'm1', event: 'msg', payload: {} }],
      retention: { maxMessages: 5 },
    });

    expect(loadInboxWatermarks(sql, 'newcomer')).toEqual([]);
  });
});
