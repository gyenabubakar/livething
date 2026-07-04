import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { advanceReceivedThrough, ensureReceiptsSchema } from '~/inbox/receipts-storage.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type { ResolvedInboxOptions } from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ReceiptsOptions } from '~/inbox/types.ts';
import { receipts } from './receipts.ts';
import { ensureInboxSchema, insertInboxRows, loadUndeliveredRows } from './storage.ts';
import { createTestSql } from './test-sql.ts';

type Handler = (ctx: unknown, frame: Protocol.IncomingProtocolFrame) => boolean | void;

function harness(
  config: ReceiptsOptions,
  opts: {
    memberCount?: number;
    inboxConfig?: ResolvedInboxOptions;
  } = {},
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
    onProtocolMessage: (event: string, handler: Handler) => handlers.set(event, handler),
    requireStorage: () => ({ sql }),
    channelMemberCount: () => opts.memberCount ?? 1,
    broadcastToChannel: (b: Record<string, unknown>) => broadcasts.push(b),
    sendProtocolFrame: (connectionId: string, frame: unknown) =>
      sentFrames.push({ connectionId, frame }),
    getInboxChannel: () => opts.inboxConfig,
  } as unknown as EngineAccess;

  receipts(config).__setup!(engine as never);
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

function receivedFrame(receivedThrough: number): Protocol.IncomingProtocolFrame {
  return {
    event: '__received__',
    payload: { receivedThrough },
    __wskit: { channel: 'room' },
  } as unknown as Protocol.IncomingProtocolFrame;
}

function seenFrame(seenThrough: number): Protocol.IncomingProtocolFrame {
  return {
    event: '__seen__',
    payload: { seenThrough },
    __wskit: { channel: 'room' },
  } as unknown as Protocol.IncomingProtocolFrame;
}

describe('receipts __received__ handler', () => {
  it('broadcasts a __receipt__ only when the cursor actually advances', () => {
    const { handlers, broadcasts } = harness({});
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__received__')!(ctx, receivedFrame(5));
    handlers.get('__received__')!(ctx, receivedFrame(3));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ event: '__receipt__' });
    expect(broadcasts[0]!.payload).toMatchObject({ identity: 'alice', receivedThrough: 5 });
  });

  it('persists the cursor but suppresses the broadcast above broadcastUpTo', () => {
    const { sql, handlers, broadcasts } = harness({ broadcastUpTo: 2 }, { memberCount: 3 });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));

    handlers.get('__received__')!(ctx, receivedFrame(5));

    expect(broadcasts).toEqual([]);
    expect(
      advanceReceivedThrough(sql, {
        channelName: 'room',
        channelFamily: null,
        identity: 'alice',
        receivedThrough: 0,
        now: 1,
      }).receivedThrough,
    ).toBe(5);
  });

  it('returns false so the inbox handler still runs its row deletion', () => {
    const { handlers } = harness({});
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));
    expect(handlers.get('__received__')!(ctx, receivedFrame(5))).toBe(false);
  });

  it('drops the ack from a non-member (no cursor advance, no broadcast)', () => {
    const { handlers, broadcasts } = harness({});
    const nonMember = { id: 'c1', channelMemberships: new Map() };
    const ctx = ctxFor('alice', nonMember);

    const result = handlers.get('__received__')!(ctx, receivedFrame(5));

    expect(result).toBe(false);
    expect(broadcasts).toEqual([]);
  });
});

describe('receipts __seen__ handler', () => {
  it('is a no-op returning true when seen tracking is off', () => {
    const { handlers, broadcasts } = harness({ seen: false });
    const ctx = ctxFor('alice', memberConnection('c1', 'room'));
    expect(handlers.get('__seen__')!(ctx, seenFrame(5))).toBe(true);
    expect(broadcasts).toEqual([]);
  });

  it('advances the cursor, broadcasts, and settles inbox rows up to received_through', () => {
    const inboxConfig: ResolvedInboxOptions = { afterDelivered: 'delete' };
    const { sql, handlers, broadcasts } = harness({ seen: true }, { inboxConfig });
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
    // seen implies received up to 5, so the inbox row at seq 3 is deleted.
    expect(loadUndeliveredRows(sql, 'alice')).toEqual([]);
  });

  it('drops a non-member seen ack', () => {
    const { handlers, broadcasts } = harness({ seen: true });
    const ctx = ctxFor('alice', { id: 'c1', channelMemberships: new Map() });
    expect(handlers.get('__seen__')!(ctx, seenFrame(5))).toBe(true);
    expect(broadcasts).toEqual([]);
  });
});

describe('receipts __receiptQuery__ handler', () => {
  function queryFrame(kind: 'seen' | 'received', seq: number): Protocol.IncomingProtocolFrame {
    return {
      event: '__receiptQuery__',
      payload: { seq, kind },
      __wskit: { channel: 'room', correlationId: 'q-1' },
    } as unknown as Protocol.IncomingProtocolFrame;
  }

  it('answers a member on the same __receiptQuery__ event echoing the correlationId', () => {
    const { sql, handlers, sentFrames } = harness({});
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
    expect(sentFrames[0]!.connectionId).toBe('c1');
    expect(sentFrames[0]!.frame).toMatchObject({
      event: '__receiptQuery__',
      payload: { identities: ['bob'] },
      wskit: { channel: 'room', correlationId: 'q-1' },
    });
  });

  it('drops a query from a non-member and sends nothing', () => {
    const { handlers, sentFrames } = harness({});
    const ctx = ctxFor('alice', { id: 'c1', channelMemberships: new Map() });

    handlers.get('__receiptQuery__')!(ctx, queryFrame('received', 5));

    expect(sentFrames).toEqual([]);
  });
});

describe('receipts scope isolation', () => {
  it('ignores a frame scoped to a different channel', () => {
    const { handlers, broadcasts } = harness({});
    const ctx = {
      identity: 'alice',
      [ENGINE_CHANNEL_META]: { channelName: 'other', channelFamily: null },
      [ENGINE_INTERNAL_CONNECTION]: memberConnection('c1', 'other'),
    };
    const frame = {
      event: '__received__',
      payload: { receivedThrough: 5 },
      __wskit: { channel: 'other' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__received__')!(ctx, frame)).toBe(false);
    expect(broadcasts).toEqual([]);
  });
});

describe('receipts default timeout wiring', () => {
  it('registers received, seen, and receiptQuery handlers', () => {
    const { handlers } = harness({ seen: true });
    expect([...handlers.keys()].sort()).toEqual(['__receiptQuery__', '__received__', '__seen__']);
  });
});
