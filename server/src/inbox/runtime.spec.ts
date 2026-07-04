import * as Wire from '~/_engine/runtime/wire.ts';
import { ensurePersistenceSchema, insertMembership } from '~/persistence/storage.ts';
import { ensureSequenceSchema } from '~/sequence/runtime.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { ResolvedInboxOptions } from '~/_engine/runtime/feature-slots.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import {
  backfillInbox,
  clearInboxForChannel,
  drainInboxOnReconnect,
  fanOutToInbox,
} from './runtime.ts';
import {
  bumpInboxWatermark,
  ensureInboxSchema,
  insertInboxRows,
  loadInboxWatermarks,
  loadUndeliveredRows,
} from './storage.ts';
import { createTestSql } from './test-sql.ts';

function createCore(inboxChannels: Map<string, ResolvedInboxOptions> = new Map()) {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  ensurePersistenceSchema(sql);
  ensureSequenceSchema(sql);
  let idCounter = 0;
  const core = {
    inboxChannels,
    requireStorage: () => ({ sql }),
    generateId: (prefix = 'id') => `${prefix}_${++idCounter}`,
  } as unknown as EngineCore;
  return { core, sql };
}

function connection(identity: string | null): RuntimeConnection {
  return { identity } as unknown as RuntimeConnection;
}

const deliver: ResolvedInboxOptions = { afterDelivered: 'delete', broadcastUpTo: 256 };

afterEach(() => vi.restoreAllMocks());

describe('fanOutToInbox', () => {
  it('writes nothing for a non-inbox channel', () => {
    const { core, sql } = createCore();
    insertMembership(sql, { identity: 'alice', channelName: 'room', channelFamily: null });

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
    insertMembership(sql, { identity: 'alice', channelName: 'room', channelFamily: null });
    insertMembership(sql, { identity: 'bob', channelName: 'room', channelFamily: null });

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
    insertMembership(sql, { identity: 'alice', channelName: 'room', channelFamily: null });
    insertMembership(sql, { identity: '', channelName: 'room', channelFamily: null });

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

  it('resolves a family channel by its family key', () => {
    const { core, sql } = createCore(new Map([['rooms', deliver]]));
    insertMembership(sql, { identity: 'alice', channelName: 'room-1', channelFamily: 'rooms' });

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
  it('is a no-op for a connection with no identity', () => {
    const { core } = createCore();
    const gap = vi.spyOn(Wire, 'sendGap').mockImplementation(() => {});
    const replay = vi.spyOn(Wire, 'sendReplay').mockImplementation(() => {});

    drainInboxOnReconnect(core, connection(null));

    expect(gap).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('emits every watermark gap BEFORE any replay row, then clears the watermarks', () => {
    const { core, sql } = createCore();
    const calls: string[] = [];
    vi.spyOn(Wire, 'sendGap').mockImplementation((_c, _conn, opts) =>
      calls.push(`gap:${opts.channelName}:${opts.missedThrough}`),
    );
    vi.spyOn(Wire, 'sendReplay').mockImplementation((_c, _conn, opts) =>
      calls.push(`row:${opts.channelName}:${opts.wire.seq}`),
    );

    bumpInboxWatermark(sql, {
      identity: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 7,
    });
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { seq: 8, messageId: 'm8', event: 'msg', payload: {} },
      now: 1,
    });

    drainInboxOnReconnect(core, connection('alice'));

    expect(calls).toEqual(['gap:room:7', 'row:room:8']);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });

  it('emits a gap even when there are zero undelivered rows behind it', () => {
    const { core, sql } = createCore();
    const gap = vi.spyOn(Wire, 'sendGap').mockImplementation(() => {});
    vi.spyOn(Wire, 'sendReplay').mockImplementation(() => {});

    bumpInboxWatermark(sql, {
      identity: 'alice',
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
        identities: ['alice'],
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
});

describe('clearInboxForChannel', () => {
  it('drops the identity rows AND the overflow watermark for the left channel only', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { seq: 1, messageId: 'm1', event: 'msg', payload: {} },
      now: 1,
    });
    bumpInboxWatermark(sql, {
      identity: 'alice',
      channelName: 'room',
      channelFamily: null,
      evictedThroughSeq: 5,
    });

    clearInboxForChannel(core, { identity: 'alice', channelName: 'room', channelFamily: null });

    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
    expect(loadInboxWatermarks(sql, 'alice')).toEqual([]);
  });

  it('is a no-op for an anonymous identity or a non-inbox channel', () => {
    const { core, sql } = createCore(new Map([['room', deliver]]));
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'lobby',
      channelFamily: null,
      frame: { seq: 1, messageId: 'm1', event: 'msg', payload: {} },
      now: 1,
    });

    clearInboxForChannel(core, { identity: '', channelName: 'room', channelFamily: null });
    clearInboxForChannel(core, { identity: 'alice', channelName: 'lobby', channelFamily: null });

    expect(loadUndeliveredRows(sql, 'alice')).toHaveLength(1);
  });
});

describe('backfillInbox', () => {
  it('seeds one identity from full frames and ignores an anonymous identity', () => {
    const { sql } = createCore();
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      identity: 'newcomer',
      frames: [
        { seq: 1, messageId: 'm1', event: 'msg', payload: { n: 1 } },
        { seq: 2, messageId: 'm2', event: 'msg', payload: { n: 2 } },
      ],
    });
    backfillInbox(sql, {
      channelName: 'room',
      channelFamily: null,
      identity: '',
      frames: [{ seq: 9, messageId: 'm9', event: 'msg', payload: {} }],
    });

    expect(loadUndeliveredRows(sql, 'newcomer').map((r) => r.seq)).toEqual([1, 2]);
    expect(loadUndeliveredRows(sql, '')).toEqual([]);
  });
});
