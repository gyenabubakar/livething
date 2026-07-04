import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import { inbox } from './inbox.ts';
import { ensureInboxSchema, insertInboxRows, loadUndeliveredRows } from './storage.ts';
import { createTestSql } from './test-sql.ts';
import type { InboxOptions } from './types.ts';

type Handler = (ctx: unknown, frame: Protocol.IncomingProtocolFrame) => boolean | void;

function harness(config: InboxOptions = {}) {
  const sql = createTestSql();
  ensureInboxSchema(sql);
  const handlers = new Map<string, Handler>();

  const engine = {
    getScopeInfo: () => ({ channelKey: 'room' }),
    onBootSchema: () => {},
    extendContext: () => {},
    onProtocolMessage: (event: string, handler: Handler) => handlers.set(event, handler),
    installOnce: (_key: symbol, run: () => void) => run(),
    setInboxService: () => {},
    registerInboxChannel: () => {},
    requireStorage: () => ({ sql }),
  } as unknown as EngineAccess;

  inbox(config).__setup!(engine as never);
  return { sql, handlers };
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

  it('always returns false so receipts can also observe the ack', () => {
    const { handlers } = harness();
    expect(handlers.get('__received__')!(ctxFor('alice', member()), receivedFrame(1))).toBe(false);
  });
});
