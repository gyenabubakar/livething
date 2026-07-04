import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import { inbox } from './inbox.ts';
import { listReceivedBy } from './receipts-storage.ts';
import { ensureInboxSchema, insertInboxRows, loadUndeliveredRows } from './storage.ts';
import { createTestSql } from './test-sql.ts';
import type { InboxOptions } from './types.ts';

type Handler = (ctx: unknown, frame: Protocol.IncomingProtocolFrame) => boolean | void;

function harness(config: InboxOptions = {}, opts: { memberCount?: number } = {}) {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  const handlers = new Map<string, Handler>();
  const broadcasts: Array<Record<string, unknown>> = [];

  const bootSchemaHooks: Array<() => void> = [];
  const engine = {
    getScopeInfo: () => ({ channelKey: 'room' }),
    onBootSchema: (run: () => void) => bootSchemaHooks.push(run),
    extendContext: () => {},
    onProtocolMessage: (event: string, handler: Handler) => handlers.set(event, handler),
    installOnce: (_key: symbol, run: () => void) => run(),
    setInboxService: () => {},
    registerInboxChannel: () => {},
    requireStorage: () => ({ sql }),
    channelMemberCount: () => opts.memberCount ?? 1,
    broadcastToChannel: (b: Record<string, unknown>) => broadcasts.push(b),
  } as unknown as EngineAccess;

  inbox(config).__setup!(engine as never);
  for (const run of bootSchemaHooks) run();
  return { sql, handlers, broadcasts };
}

function ctxFor(identity: string, connection: unknown) {
  return {
    identity,
    [ENGINE_CHANNEL_META]: { channelName: 'room', channelFamily: null },
    [ENGINE_INTERNAL_CONNECTION]: connection,
  };
}

function member() {
  return {
    id: 'c1',
    channelMemberships: new Map([
      [createChannelMembershipKey('room', null), { channelName: 'room', channelFamily: null }],
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

describe('inbox __received__ handler', () => {
  function seedRow(sql: ReturnType<typeof harness>['sql'], seq: number) {
    insertInboxRows(sql, {
      identities: ['alice'],
      channelName: 'room',
      channelFamily: null,
      frame: { seq, messageId: `m${seq}`, event: 'msg', payload: {} },
      now: 1,
    });
  }

  it('settles a member ack by deleting rows up to receivedThrough', () => {
    const { sql, handlers } = harness();
    seedRow(sql, 1);
    seedRow(sql, 2);

    handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(1));

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([2]);
  });

  it('drops the ack from a socket that has left the channel', () => {
    const { sql, handlers } = harness();
    seedRow(sql, 1);
    const nonMember = { id: 'c1', channelMemberships: new Map() };

    handlers.get('__received__')!(ctxFor('alice', nonMember), receivedFrame(1));

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([1]);
  });

  it('drops the ack from an anonymous identity', () => {
    const { sql, handlers } = harness();
    seedRow(sql, 1);

    handlers.get('__received__')!(ctxFor('', member()), receivedFrame(1));

    expect(loadUndeliveredRows(sql, 'alice').map((r) => r.seq)).toEqual([1]);
  });

  it('always returns false so read-receipts can also observe the ack', () => {
    const { handlers } = harness();
    expect(handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(1))).toBe(false);
  });
});

describe('inbox delivered acknowledgement (the double-grey check)', () => {
  it('advances the received cursor and broadcasts a delivered __receipt__', () => {
    const { handlers, broadcasts } = harness();

    handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(5));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ event: '__receipt__' });
    expect(broadcasts[0]!.payload).toMatchObject({ identity: 'alice', receivedThrough: 5 });
    expect(broadcasts[0]!.payload).not.toHaveProperty('seenThrough');
  });

  it('broadcasts the delivered tick only when the cursor advances', () => {
    const { handlers, broadcasts } = harness();
    const ctx = ctxFor('alice', member());

    handlers.get('__received__')!(ctx, receivedFrame(5));
    handlers.get('__received__')!(ctx, receivedFrame(3));

    expect(broadcasts).toHaveLength(1);
  });

  it('suppresses the delivered tick above the 256-member cap but keeps the cursor', () => {
    const { handlers, broadcasts } = harness({}, { memberCount: 300 });

    handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(5));

    expect(broadcasts).toEqual([]);
  });

  it('records receivedBy after a delivered ack', () => {
    const { sql, handlers } = harness();
    handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(5));

    expect(listReceivedBy(sql, { channelName: 'room', channelFamily: null, seq: 5 })).toEqual([
      'alice',
    ]);
  });
});
