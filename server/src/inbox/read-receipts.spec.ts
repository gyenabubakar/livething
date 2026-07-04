import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { advanceReceivedThrough, advanceSeenThrough } from '~/inbox/receipts-storage.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type {
  ResolvedInboxOptions,
  ResolvedReadReceiptsOptions,
} from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import { readReceipts } from './read-receipts.ts';
import { ensureReceiptsSchema } from './receipts-storage.ts';
import { ensureInboxSchema, insertInboxRows, loadUndeliveredRows } from './storage.ts';
import { createTestSql } from './test-sql.ts';

type Handler = (ctx: unknown, frame: Protocol.IncomingProtocolFrame) => boolean | void;

function harness(
  options: ResolvedReadReceiptsOptions,
  opts: { memberCount?: number; inboxConfig?: ResolvedInboxOptions } = {},
) {
  const sql = createTestSql();
  ensureReceiptsSchema(sql);
  ensureInboxSchema(sql);

  const handlers = new Map<string, Handler>();
  const broadcasts: Array<Record<string, unknown>> = [];
  const sentFrames: Array<{ connectionId: string; frame: unknown }> = [];

  const engine = {
    getScopeInfo: () => ({ channelKey: 'room' }),
    onBootSchema: () => {},
    extendContext: () => {},
    registerReadReceiptsChannel: () => {},
    onProtocolMessage: (event: string, handler: Handler) => handlers.set(event, handler),
    requireStorage: () => ({ sql }),
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

function ctxFor(identity: string, connection: unknown) {
  return {
    identity,
    [ENGINE_CHANNEL_META]: { channelName: 'room', channelFamily: null },
    [ENGINE_INTERNAL_CONNECTION]: connection,
  };
}

function seenFrame(seenThrough: number): Protocol.IncomingProtocolFrame {
  return {
    event: '__seen__',
    payload: { seenThrough },
    __wskit: { channel: 'room' },
  } as unknown as Protocol.IncomingProtocolFrame;
}

describe('readReceipts registers only seen and query handlers', () => {
  it('owns __seen__ and __receiptQuery__ but not __received__', () => {
    const { handlers } = harness({ broadcastUpTo: 256 });
    expect([...handlers.keys()].sort()).toEqual(['__receiptQuery__', '__seen__']);
  });
});

describe('readReceipts __seen__ handler', () => {
  it('advances the cursor, broadcasts, and settles inbox rows up to received_through', () => {
    const inboxConfig: ResolvedInboxOptions = { afterDelivered: 'delete', broadcastUpTo: 256 };
    const { sql, handlers, broadcasts } = harness({ broadcastUpTo: 256 }, { inboxConfig });
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { seq: 3, messageId: 'm3', event: 'msg', payload: {} },
      now: 1,
    });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__seen__')!(ctx, seenFrame(5));

    expect(broadcasts[0]!.payload).toMatchObject({ seenThrough: 5, receivedThrough: 5 });
    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
  });

  it('broadcasts the read tick only when the cursor actually advances', () => {
    const { handlers, broadcasts } = harness({ broadcastUpTo: 256 });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__seen__')!(ctx, seenFrame(5));
    handlers.get('__seen__')!(ctx, seenFrame(3));

    expect(broadcasts).toHaveLength(1);
  });

  it('persists the seen cursor but suppresses the tick above broadcastUpTo', () => {
    const { sql, handlers, broadcasts } = harness({ broadcastUpTo: 2 }, { memberCount: 3 });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__seen__')!(ctx, seenFrame(5));

    expect(broadcasts).toEqual([]);
    expect(
      advanceSeenThrough(sql, {
        channelName: 'room',
        channelFamily: null,
        identity: 'alice',
        seenThrough: 0,
        now: 1,
      }).seenThrough,
    ).toBe(5);
  });

  it('drops a non-member seen ack', () => {
    const { handlers, broadcasts } = harness({ broadcastUpTo: 256 });
    const ctx = ctxFor('alice', { id: 'c1', channelMemberships: new Map() });
    expect(handlers.get('__seen__')!(ctx, seenFrame(5))).toBe(true);
    expect(broadcasts).toEqual([]);
  });
});

describe('readReceipts __receiptQuery__ handler', () => {
  function queryFrame(kind: 'seen' | 'received', seq: number): Protocol.IncomingProtocolFrame {
    return {
      event: '__receiptQuery__',
      payload: { seq, kind },
      __wskit: { channel: 'room', correlationId: 'q-1' },
    } as unknown as Protocol.IncomingProtocolFrame;
  }

  it('answers a received query too, since the channel always has inbox', () => {
    const { sql, handlers, sentFrames } = harness({ broadcastUpTo: 256 });
    advanceReceivedThrough(sql, {
      channelName: 'room',
      channelFamily: null,
      identity: 'bob',
      receivedThrough: 10,
      now: 1,
    });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__receiptQuery__')!(ctx, queryFrame('received', 5));

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]!.frame).toMatchObject({
      event: '__receiptQuery__',
      payload: { identities: ['bob'] },
      wskit: { channel: 'room', correlationId: 'q-1' },
    });
  });

  it('answers a seen query with the seen cursor', () => {
    const { sql, handlers, sentFrames } = harness({ broadcastUpTo: 256 });
    advanceSeenThrough(sql, {
      channelName: 'room',
      channelFamily: null,
      identity: 'bob',
      seenThrough: 10,
      now: 1,
    });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__receiptQuery__')!(ctx, queryFrame('seen', 5));

    expect(sentFrames[0]!.frame).toMatchObject({ payload: { identities: ['bob'] } });
  });

  it('drops a query from a non-member and sends nothing', () => {
    const { handlers, sentFrames } = harness({ broadcastUpTo: 256 });
    const ctx = ctxFor('alice', { id: 'c1', channelMemberships: new Map() });

    handlers.get('__receiptQuery__')!(ctx, queryFrame('received', 5));

    expect(sentFrames).toEqual([]);
  });
});

describe('readReceipts scope isolation', () => {
  it('ignores a seen frame scoped to a different channel', () => {
    const { handlers, broadcasts } = harness({ broadcastUpTo: 256 });
    const ctx = {
      identity: 'alice',
      [ENGINE_CHANNEL_META]: { channelName: 'other', channelFamily: null },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection('c1', 'other'),
    };
    const frame = {
      event: '__seen__',
      payload: { seenThrough: 5 },
      __wskit: { channel: 'other' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__seen__')!(ctx, frame)).toBe(false);
    expect(broadcasts).toEqual([]);
  });
});
