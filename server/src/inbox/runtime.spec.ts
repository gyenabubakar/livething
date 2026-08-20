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
  scopeMatchesChannel,
} from './runtime.ts';
import {
  bumpInboxWatermark,
  ensureInboxSchema,
  insertInboxRows,
  loadInboxWatermarks,
  loadUndeliveredRows,
} from './storage.ts';

function createCore(inboxChannels: Map<string, ResolvedInboxOptions> = new Map()) {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  ensureMembershipSchema(sql);
  ensureSequenceSchema(sql);
  let idCounter = 0;
  const core = {
    inboxChannels,
    storage: { sql },
    generateId: (prefix = 'id') => `${prefix}_${++idCounter}`,
  } as unknown as EngineCore;
  return { core, sql };
}

function connection(userId: string | null): RuntimeConnection {
  return { userId } as unknown as RuntimeConnection;
}

const deliver: ResolvedInboxOptions = {
  onDelivered: 'delete',
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
      seq: 1,
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
      seq: 42,
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
      seq: 1,
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
      seq: 1,
      messageId: 'm1',
    });

    expect(sql.exec('SELECT COUNT(*) AS c FROM __wskit_inbox').one() as { c: number }).toEqual({
      c: 0,
    });
  });

  it('excludeUserId skips that member entirely (regression: sender got its own message back)', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertMembership(sql, { userId: 'alice', channelName: 'room', channelFamily: null });
    insertMembership(sql, { userId: 'bob', channelName: 'room', channelFamily: null });

    fanOutToInbox(core, {
      channelName: 'room',
      channelFamily: null,
      event: 'msg',
      payload: { text: 'hi' },
      seq: 1,
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
      seq: 1,
      messageId: 'm1',
    });

    expect(loadUndeliveredRows(sql, 'alice')[0]?.channelFamily).toBe('rooms');
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
      calls.push(`row:${opts.channelName}:${opts.wire.seq}`),
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
      frame: { seq: 8, messageId: 'm8', event: 'msg', payload: {} },
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
      seqs.push(opts.wire.seq);
    });

    for (const seq of [3, 1, 2]) {
      insertInboxRows(sql, {
        userIds: ['alice'],
        channelName: 'room',
        channelFamily: null,
        frame: { seq, messageId: `m${seq}`, event: 'msg', payload: {} },
        now: 1,
      });
    }

    drainInboxOnReconnect(core, connection('alice'));

    expect(gap).not.toHaveBeenCalled();
    expect(seqs).toEqual([1, 2, 3]);
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
      onDelivered: 'delete',
    });

    drainInboxOnReconnect(core, connection('alice'));

    expect(gaps).toEqual([]);
  });
});

describe('clearInboxForChannel', () => {
  it('drops the user id rows AND the overflow watermark for the left channel only', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { seq: 1, messageId: 'm1', event: 'msg', payload: {} },
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
  });

  it('is a no-op for an anonymous user id or a non-inbox channel', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'lobby',
      channelFamily: null,
      frame: { seq: 1, messageId: 'm1', event: 'msg', payload: {} },
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
        { seq: 1, messageId: 'm1', event: 'msg', payload: { n: 1 } },
        { seq: 2, messageId: 'm2', event: 'msg', payload: { n: 2 } },
      ],
    });
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: '',
      frames: [{ seq: 9, messageId: 'm9', event: 'msg', payload: {} }],
    });

    expect(loadUndeliveredRows(sql, 'newcomer').map((r) => r.seq)).toEqual([1, 2]);
    expect(loadUndeliveredRows(sql, '')).toEqual([]);
  });

  it('does nothing without retention passed (regression: backfill bypassed retention entirely)', () => {
    const { sql } = createCore();
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'newcomer',
      frames: [1, 2, 3, 4, 5].map((seq) => ({
        seq,
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
        seq,
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
      frames: [1, 2, 3].map((seq) => ({ seq, messageId: `m${seq}`, event: 'msg', payload: {} })),
      retention: { maxMessages: 1 },
    });

    expect(loadInboxWatermarks(sql, 'newcomer')).toEqual([
      { channelName: 'room', channelFamily: null, evictedThroughSeq: 2 },
    ]);
  });

  it('retention already satisfied by the backfill leaves no watermark', () => {
    const { sql } = createCore();
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'newcomer',
      frames: [{ seq: 1, messageId: 'm1', event: 'msg', payload: {} }],
      retention: { maxMessages: 5 },
    });

    expect(loadInboxWatermarks(sql, 'newcomer')).toEqual([]);
  });
});
