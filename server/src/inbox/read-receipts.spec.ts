import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { createTestSql } from '~/_test/sql.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import {
  advanceReadThrough,
  advanceReceivedThrough,
  ensureReceiptsSchema,
} from '~/inbox/receipts-storage.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type {
  ResolvedInboxOptions,
  ResolvedReadReceiptsOptions,
} from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import { readReceipts } from './read-receipts.ts';
import { ensureInboxSchema, insertInboxRows, loadUndeliveredRows } from './storage.ts';

type Handler = (ctx: unknown, frame: Protocol.IncomingProtocolFrame) => boolean | void;

function harness(
  options: ResolvedReadReceiptsOptions,
  opts: { memberCount?: number; inboxConfig?: ResolvedInboxOptions; channelKey?: string } = {},
) {
  const sql = createTestSql();
  ensureReceiptsSchema(sql);
  ensureInboxSchema(sql);

  const handlers = new Map<string, Handler>();
  const broadcasts: Array<Record<string, unknown>> = [];
  const sentFrames: Array<{ connectionId: string; frame: unknown }> = [];

  const engine = {
    getScopeInfo: () => ({ channelKey: opts.channelKey ?? 'room' }),
    onBootSchema: () => {},
    extendContext: () => {},
    registerReadReceiptsChannel: () => {},
    installOnce: (_key: symbol, run: () => void) => run(),
    addChannelHandleAugmenter: () => {},
    hasReadReceiptsChannel: () => true,
    onProtocolMessage: (event: string, handler: Handler) => handlers.set(event, handler),
    storage: { sql },
    channelMemberCount: () => opts.memberCount ?? 1,
    broadcastToChannel: (b: Record<string, unknown>) => broadcasts.push(b),
    sendProtocolFrame: (connectionId: string, frame: unknown) =>
      sentFrames.push({ connectionId, frame }),
    getInboxChannel: () => opts.inboxConfig,
  } as unknown as EngineAccess;

  readReceipts(options).__setup!(engine as never);
  return { sql, handlers, broadcasts, sentFrames };
}

function memberConnection(id: string, channelName: string, channelFamily: string | null = null) {
  return {
    id,
    channelMemberships: new Map([
      [createChannelMembershipKey(channelName, channelFamily), { channelName, channelFamily }],
    ]),
  };
}

function ctxFor(userId: string, connection: unknown) {
  return {
    user: { id: userId },
    [ENGINE_CHANNEL_META]: { channelName: 'room', channelFamily: null },
    [ENGINE_INTERNAL_CONNECTION]: connection,
  };
}

function readFrame(readThrough: number): Protocol.IncomingProtocolFrame {
  return {
    event: '__read__',
    payload: { readThrough },
    __wskit: { channel: 'room' },
  } as unknown as Protocol.IncomingProtocolFrame;
}

describe('readReceipts registers only read and read-query handlers', () => {
  it('owns __read__ and __readQuery__ but not __received__', () => {
    const { handlers } = harness({ maxReceiptAudience: 256 });
    expect([...handlers.keys()].sort()).toEqual(['__readQuery__', '__read__']);
  });
});

describe('readReceipts __read__ handler', () => {
  it('advances the cursor, fans out __read__, and settles inbox rows up to received_through', () => {
    const inboxConfig: ResolvedInboxOptions = {
      onDelivered: 'delete',
      broadcastReceipts: true,
      maxReceiptAudience: 256,
    };
    const { sql, handlers, broadcasts } = harness({ maxReceiptAudience: 256 }, { inboxConfig });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { seq: 3, messageId: 'm3', event: 'msg', payload: {} },
      now: 1,
    });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__read__')!(ctx, readFrame(5));

    // Read pulled received up from 0 → 5, so a __received__ fan-out follows the __read__.
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[0]).toMatchObject({
      event: '__read__',
      payload: { userId: 'alice', readThrough: 5 },
    });
    expect(broadcasts[1]).toMatchObject({
      event: '__received__',
      payload: { userId: 'alice', receivedThrough: 5 },
    });
    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
  });

  it('settles inbox rows but withholds the __received__ tick when inbox broadcastReceipts is off', () => {
    const inboxConfig: ResolvedInboxOptions = {
      onDelivered: 'delete',
      broadcastReceipts: false,
      maxReceiptAudience: 256,
    };
    const { sql, handlers, broadcasts } = harness({ maxReceiptAudience: 256 }, { inboxConfig });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { seq: 3, messageId: 'm3', event: 'msg', payload: {} },
      now: 1,
    });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__read__')!(ctx, readFrame(5));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ event: '__read__' });
    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
  });

  it('does not fan out __received__ when received was already ahead of the read mark', () => {
    const { sql, handlers, broadcasts } = harness({ maxReceiptAudience: 256 });
    advanceReceivedThrough(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 10,
      now: 1,
    });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__read__')!(ctx, readFrame(5));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      event: '__read__',
      payload: { userId: 'alice', readThrough: 5 },
    });
  });

  it('fans out the read tick only when the cursor actually advances', () => {
    const { handlers, broadcasts } = harness({ maxReceiptAudience: 256 });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__read__')!(ctx, readFrame(5));
    broadcasts.length = 0;
    handlers.get('__read__')!(ctx, readFrame(3));

    expect(broadcasts).toEqual([]);
  });

  it('persists the read cursor but suppresses the tick above maxReceiptAudience', () => {
    const { sql, handlers, broadcasts } = harness({ maxReceiptAudience: 2 }, { memberCount: 3 });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__read__')!(ctx, readFrame(5));

    expect(broadcasts).toEqual([]);
    expect(
      advanceReadThrough(sql, {
        channelName: 'room',
        channelFamily: null,
        userId: 'alice',
        readThrough: 0,
        now: 1,
      }).readThrough,
    ).toBe(5);
  });

  it('drops a non-member read ack', () => {
    const { handlers, broadcasts } = harness({ maxReceiptAudience: 256 });
    const ctx = ctxFor('alice', { id: 'c1', channelMemberships: new Map() });
    expect(handlers.get('__read__')!(ctx, readFrame(5))).toBe(true);
    expect(broadcasts).toEqual([]);
  });
});

describe('readReceipts __readQuery__ handler', () => {
  function queryFrame(seq: number): Protocol.IncomingProtocolFrame {
    return {
      event: '__readQuery__',
      payload: { seq },
      __wskit: { channel: 'room', correlationId: 'q-1' },
    } as unknown as Protocol.IncomingProtocolFrame;
  }

  it('answers a read query with the read cursor', () => {
    const { sql, handlers, sentFrames } = harness({ maxReceiptAudience: 256 });
    advanceReadThrough(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'bob',
      readThrough: 10,
      now: 1,
    });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__readQuery__')!(ctx, queryFrame(5));

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]!.frame).toMatchObject({
      event: '__readQuery__',
      payload: { userIds: ['bob'] },
      wskit: { channel: 'room', correlationId: 'q-1' },
    });
  });

  it('drops a query from a non-member and sends nothing', () => {
    const { handlers, sentFrames } = harness({ maxReceiptAudience: 256 });
    const ctx = ctxFor('alice', { id: 'c1', channelMemberships: new Map() });

    handlers.get('__readQuery__')!(ctx, queryFrame(5));

    expect(sentFrames).toEqual([]);
  });
});

describe('readReceipts scope isolation', () => {
  it('ignores a read frame scoped to a different channel', () => {
    const { handlers, broadcasts } = harness({ maxReceiptAudience: 256 });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'other', channelFamily: null },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection('c1', 'other'),
    };
    const frame = {
      event: '__read__',
      payload: { readThrough: 5 },
      __wskit: { channel: 'other' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__read__')!(ctx, frame)).toBe(false);
    expect(broadcasts).toEqual([]);
  });

  it('ignores a family-scoped read frame when this handler owns a plain channel of the same name', () => {
    const { handlers, broadcasts } = harness({ maxReceiptAudience: 256 }, { channelKey: 'alpha' });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'alpha', channelFamily: 'rooms' },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection('c1', 'alpha', 'rooms'),
    };
    const frame = {
      event: '__read__',
      payload: { readThrough: 5 },
      __wskit: { channel: 'alpha', channelFamily: 'rooms' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__read__')!(ctx, frame)).toBe(false);
    expect(broadcasts).toEqual([]);
  });

  it('ignores a plain-scoped read frame when this handler owns a family of the same name', () => {
    const { handlers, broadcasts } = harness({ maxReceiptAudience: 256 }, { channelKey: 'rooms' });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'alpha', channelFamily: null },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection('c1', 'alpha'),
    };
    const frame = {
      event: '__read__',
      payload: { readThrough: 5 },
      __wskit: { channel: 'alpha' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__read__')!(ctx, frame)).toBe(false);
    expect(broadcasts).toEqual([]);
  });

  it('does not answer a family-scoped query when this handler owns a plain channel of the same name', () => {
    const { handlers, sentFrames } = harness({ maxReceiptAudience: 256 }, { channelKey: 'alpha' });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'alpha', channelFamily: 'rooms' },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection('c1', 'alpha', 'rooms'),
    };
    const frame = {
      event: '__readQuery__',
      payload: { seq: 5 },
      __wskit: { channel: 'alpha', channelFamily: 'rooms', correlationId: 'q-1' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__readQuery__')!(ctx, frame)).toBe(false);
    expect(sentFrames).toEqual([]);
  });

  it('does not answer a plain-scoped query when this handler owns a family of the same name', () => {
    const { handlers, sentFrames } = harness({ maxReceiptAudience: 256 }, { channelKey: 'rooms' });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'alpha', channelFamily: null },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection('c1', 'alpha'),
    };
    const frame = {
      event: '__readQuery__',
      payload: { seq: 5 },
      __wskit: { channel: 'alpha', correlationId: 'q-1' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__readQuery__')!(ctx, frame)).toBe(false);
    expect(sentFrames).toEqual([]);
  });
});
