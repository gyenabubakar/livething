import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { createTestSql } from '~/_test/sql.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import { inbox } from './inbox.ts';
import { advanceReceivedThrough, listReceivers } from './receipts-storage.ts';
import { ensureInboxSchema, insertInboxRows, loadUndeliveredRows } from './storage.ts';
import type { InboxOptions } from './types.ts';

type Handler = (ctx: unknown, frame: Protocol.IncomingProtocolFrame) => boolean | void;

function harness(
  config: InboxOptions = {},
  opts: { memberCount?: number; channelKey?: string } = {},
) {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  const handlers = new Map<string, Handler>();
  const broadcasts: Array<Record<string, unknown>> = [];
  const sentFrames: Array<{ connectionId: string; frame: unknown }> = [];
  const invalidateInboxMemberCount = vi.fn();

  const bootSchemaHooks: Array<() => void> = [];
  const engine = {
    getScopeInfo: () => ({ channelKey: opts.channelKey ?? 'room' }),
    onBootSchema: (run: () => void) => bootSchemaHooks.push(run),
    extendContext: () => {},
    onProtocolMessage: (event: string, handler: Handler) => handlers.set(event, handler),
    installOnce: (_key: symbol, run: () => void) => run(),
    addChannelHandleAugmenter: () => {},
    setInboxService: () => {},
    registerInboxChannel: () => {},
    onPurgeUser: () => {},
    storage: { sql },
    channelMemberCount: () => opts.memberCount ?? 1,
    broadcastToChannel: (b: Record<string, unknown>) => broadcasts.push(b),
    sendProtocolFrame: (connectionId: string, frame: unknown) =>
      sentFrames.push({ connectionId, frame }),
    invalidateInboxMemberCount,
  } as unknown as EngineAccess;

  inbox(config).__setup!(engine as never);
  for (const run of bootSchemaHooks) run();
  return { sql, handlers, broadcasts, sentFrames, invalidateInboxMemberCount };
}

function ctxFor(userId: string, connection: unknown) {
  return {
    // A stale-shaped user handle: an anonymous connection's `ctx.user.id`
    // falls back to the connection id, which is never empty. The received
    // handler must read the connection's real `userId`, not this field.
    user: { id: userId },
    [ENGINE_CHANNEL_META]: { channelName: 'room', channelFamily: null },
    [ENGINE_INTERNAL_CONNECTION]: connection,
  };
}

function member(userId = 'alice') {
  return {
    id: 'c1',
    userId,
    channelMemberships: new Map([
      [createChannelMembershipKey('room', null), { channelName: 'room', channelFamily: null }],
    ]),
  };
}

function anonymousMember() {
  return member('');
}

function memberOf(userId: string, channelName: string, channelFamily: string | null) {
  return {
    id: 'c1',
    userId,
    channelMemberships: new Map([
      [createChannelMembershipKey(channelName, channelFamily), { channelName, channelFamily }],
    ]),
  };
}

function receivedFrame(receivedThrough: number): Protocol.IncomingProtocolFrame {
  return {
    event: '__received__',
    payload: { receivedThrough },
    __wskit: { channel: 'room' },
  } as unknown as Protocol.IncomingProtocolFrame;
}

describe('inbox registers received and received-query handlers', () => {
  it('owns __received__ and __receivedQuery__', () => {
    const { handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual(['__receivedQuery__', '__received__']);
  });
});

describe('inbox __received__ handler', () => {
  function seedRow(sql: ReturnType<typeof harness>['sql'], seq: number) {
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { seq, messageId: `m${seq}`, event: 'msg', payload: {} },
      now: 1,
    });
  }

  it('settles a member ack by deleting rows up to receivedThrough', () => {
    const { sql, handlers, invalidateInboxMemberCount } = harness();
    seedRow(sql, 1);
    seedRow(sql, 2);

    handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(1));

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([2]);
    expect(invalidateInboxMemberCount).toHaveBeenCalledWith('room', null, 'alice');
  });

  it('drops the ack from a socket that has left the channel', () => {
    const { sql, handlers } = harness();
    seedRow(sql, 1);
    const nonMember = { id: 'c1', userId: 'alice', channelMemberships: new Map() };

    handlers.get('__received__')!(ctxFor('alice', nonMember), receivedFrame(1));

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([1]);
  });

  it('drops the ack from an anonymous connection', () => {
    const { sql, handlers } = harness();
    seedRow(sql, 1);

    handlers.get('__received__')!(ctxFor('', anonymousMember()), receivedFrame(1));

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([1]);
  });

  it('ignores a stale `ctx.user.id` fallback and reads the connection instead', () => {
    // A hand-built ctx whose user.id is non-empty while the connection itself
    // is anonymous. The handler must trust the connection, not the ctx.
    const { sql, handlers } = harness();
    seedRow(sql, 1);

    handlers.get('__received__')!(ctxFor('c1', anonymousMember()), receivedFrame(1));

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([1]);
    expect(listReceivers(sql, { channelName: 'room', channelFamily: null, seq: 1 })).toEqual([]);
  });

  it('always returns false so read-receipts can also observe the ack', () => {
    const { handlers } = harness();
    expect(handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(1))).toBe(false);
  });

  it('leaves a family-scoped ack alone when this handler owns a plain channel of the same name', () => {
    // A client on family 'rooms' can pick the concrete channel name 'alpha',
    // which can collide with an unrelated plain channel also called 'alpha'.
    // The plain channel's own handler must not claim the family's frame.
    const { sql, handlers } = harness({}, { channelKey: 'alpha' });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'alpha',
      channelFamily: 'rooms',
      frame: { seq: 1, messageId: 'm1', event: 'msg', payload: {} },
      now: 1,
    });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'alpha', channelFamily: 'rooms' },
      [ENGINE_INTERNAL_CONNECTION]: memberOf('alice', 'alpha', 'rooms'),
    };
    const frame = {
      event: '__received__',
      payload: { receivedThrough: 1 },
      __wskit: { channel: 'alpha', channelFamily: 'rooms' },
    } as unknown as Protocol.IncomingProtocolFrame;

    handlers.get('__received__')!(ctx, frame);

    expect(loadUndeliveredRows(sql, 'alice')).toHaveLength(1);
  });

  it('leaves a plain-scoped ack alone when this handler owns a family of the same name', () => {
    const { sql, handlers } = harness({}, { channelKey: 'rooms' });
    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'alpha',
      channelFamily: null,
      frame: { seq: 1, messageId: 'm1', event: 'msg', payload: {} },
      now: 1,
    });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'alpha', channelFamily: null },
      [ENGINE_INTERNAL_CONNECTION]: memberOf('alice', 'alpha', null),
    };
    const frame = {
      event: '__received__',
      payload: { receivedThrough: 1 },
      __wskit: { channel: 'alpha' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__received__')!(ctx, frame)).toBe(false);
    expect(loadUndeliveredRows(sql, 'alice')).toHaveLength(1);
  });
});

describe('inbox delivered acknowledgement (the double-grey check)', () => {
  it('does not fan out the delivered tick by default, but still records the cursor', () => {
    const { sql, handlers, broadcasts } = harness();

    handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(5));

    expect(broadcasts).toEqual([]);
    expect(listReceivers(sql, { channelName: 'room', channelFamily: null, seq: 5 })).toEqual([
      'alice',
    ]);
  });

  it('fans out __received__ when broadcastReceipts is on', () => {
    const { handlers, broadcasts } = harness({ broadcastReceipts: true });

    handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(5));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ event: '__received__' });
    expect(broadcasts[0]!.payload).toEqual({ userId: 'alice', receivedThrough: 5 });
  });

  it('fans out the delivered tick only when the cursor advances', () => {
    const { handlers, broadcasts } = harness({ broadcastReceipts: true });
    const ctx = ctxFor('alice', member());

    handlers.get('__received__')!(ctx, receivedFrame(5));
    handlers.get('__received__')!(ctx, receivedFrame(3));

    expect(broadcasts).toHaveLength(1);
  });

  it('suppresses the delivered tick above the 256-member cap but keeps the cursor', () => {
    const { handlers, broadcasts } = harness({ broadcastReceipts: true }, { memberCount: 300 });

    handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(5));

    expect(broadcasts).toEqual([]);
  });
});

describe('inbox __receivedQuery__ handler', () => {
  function queryFrame(seq: number): Protocol.IncomingProtocolFrame {
    return {
      event: '__receivedQuery__',
      payload: { seq },
      __wskit: { channel: 'room', correlationId: 'q-1' },
    } as unknown as Protocol.IncomingProtocolFrame;
  }

  it('answers a received query without readReceipts present', () => {
    const { sql, handlers, sentFrames } = harness();
    advanceReceivedThrough(sql, {
      channelName: 'room',
      channelFamily: null,
      userId: 'bob',
      receivedThrough: 10,
      now: 1,
    });

    handlers.get('__receivedQuery__')!(ctxFor('alice', member()), queryFrame(5));

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]!.frame).toMatchObject({
      event: '__receivedQuery__',
      payload: { userIds: ['bob'] },
      wskit: { channel: 'room', correlationId: 'q-1' },
    });
  });

  it('drops a query from a non-member and sends nothing', () => {
    const { handlers, sentFrames } = harness();
    const ctx = ctxFor('alice', { id: 'c1', channelMemberships: new Map() });

    handlers.get('__receivedQuery__')!(ctx, queryFrame(5));

    expect(sentFrames).toEqual([]);
  });

  it('does not answer a family-scoped query when this handler owns a plain channel of the same name', () => {
    const { handlers, sentFrames } = harness({}, { channelKey: 'alpha' });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'alpha', channelFamily: 'rooms' },
      [ENGINE_INTERNAL_CONNECTION]: memberOf('alice', 'alpha', 'rooms'),
    };
    const frame = {
      event: '__receivedQuery__',
      payload: { seq: 5 },
      __wskit: { channel: 'alpha', channelFamily: 'rooms', correlationId: 'q-1' },
    } as unknown as Protocol.IncomingProtocolFrame;

    handlers.get('__receivedQuery__')!(ctx, frame);

    expect(sentFrames).toEqual([]);
  });

  it('does not answer a plain-scoped query when this handler owns a family of the same name', () => {
    const { handlers, sentFrames } = harness({}, { channelKey: 'rooms' });
    const ctx = {
      user: { id: 'alice' },
      [ENGINE_CHANNEL_META]: { channelName: 'alpha', channelFamily: null },
      [ENGINE_INTERNAL_CONNECTION]: memberOf('alice', 'alpha', null),
    };
    const frame = {
      event: '__receivedQuery__',
      payload: { seq: 5 },
      __wskit: { channel: 'alpha', correlationId: 'q-1' },
    } as unknown as Protocol.IncomingProtocolFrame;

    expect(handlers.get('__receivedQuery__')!(ctx, frame)).toBe(false);
    expect(sentFrames).toEqual([]);
  });
});
