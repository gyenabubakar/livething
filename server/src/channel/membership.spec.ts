import { createTestSql } from '~/_test/sql.ts';
import {
  deleteDurableMembership,
  hasDurableMembership,
  persistMembership,
} from '~/channel/membership.ts';
import { addChannelMembership, kickChannelMembers, leaveChannel } from '~/channel/runtime.ts';
import { ensureMembershipSchema } from '~/channel/storage.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';

function makeCore(sql: SQLProvider): EngineCore {
  return {
    persistenceEnabled: true,
    storage: { sql },
  } as unknown as EngineCore;
}

describe('durable membership user gate', () => {
  it('skips the durable write for an empty (anonymous) user id', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensureMembershipSchema(sql);
    statements = 0;

    persistMembership(makeCore(sql), { userId: '', channelName: 'room', channelFamily: null });
    expect(statements).toBe(0);
  });

  it('writes the durable row for a real user id', () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);

    persistMembership(makeCore(sql), {
      userId: 'user-1',
      channelName: 'room',
      channelFamily: null,
    });
    expect(
      hasDurableMembership(makeCore(sql), {
        userId: 'user-1',
        channelName: 'room',
        channelFamily: null,
      }),
    ).toBe(true);
  });

  it('skips the durable delete for an empty user id', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensureMembershipSchema(sql);
    statements = 0;

    deleteDurableMembership(makeCore(sql), {
      userId: '',
      channelName: 'room',
      channelFamily: null,
    });
    expect(statements).toBe(0);
  });

  it('reports no durable membership for an empty user id without querying', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensureMembershipSchema(sql);
    statements = 0;

    const result = hasDurableMembership(makeCore(sql), {
      userId: '',
      channelName: 'room',
      channelFamily: null,
    });
    expect(result).toBe(false);
    expect(statements).toBe(0);
  });
});

describe('kick(userRef, { revoke: true })', () => {
  function userRef(id: string): { __wskit: 'user-ref'; id: string; instance: string | undefined } {
    return { __wskit: 'user-ref', id, instance: undefined };
  }

  function makeConnection(id: string, userId: string): RuntimeConnection {
    return {
      id,
      userId,
      wsKey: Symbol(id),
      descriptor: { send() {}, close() {}, bufferedAmount: () => 0, identity: userId },
      meta: {},
      tags: { ephemeral: new Map(), persistent: new Map() },
      channelMemberships: new Map(),
      latency: null,
      quality: 'good',
    };
  }

  const roomChannel = {
    key: 'room',
    kind: 'channel' as const,
    pattern: 'room',
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
  };

  function makeRuntime(
    channelMembers: Map<string, Set<RuntimeConnection>>,
    connections: Map<string, RuntimeConnection>,
    deleteDurableMembership: ReturnType<typeof vi.fn>,
  ) {
    return {
      compiled: { channels: new Map([['room', roomChannel]]), channelFamilies: new Map() },
      connections,
      channelMembers,
      checkHooks: new Map(),
      revalidateHooks: new Map(),
      commitHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map(),
      sessionEndHooks: new Map(),
      logger: { error: vi.fn() },
      toConnectionInfo: () => ({}) as unknown as ReturnType<typeof vi.fn>,
      buildConnectionContext: () => ({}),
      persistAttachment() {},
      sendProtocolMessage() {},
      broadcastToChannel() {},
      async handleValidationError() {},
      isChannelPersistent: () => true,
      persistMembership() {},
      deleteDurableMembership,
      hasDurableMembership: () => true,
    };
  }

  it('drops the durable row and makes the live socket leave', async () => {
    const connection = makeConnection('conn_1', 'user-1');
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    addChannelMembership(channelMembers, connection, { channelName: 'room', channelFamily: null });
    const deleteDurableMembership = vi.fn();
    const runtime = makeRuntime(
      channelMembers,
      new Map([[connection.id, connection]]),
      deleteDurableMembership,
    );

    await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: (c: RuntimeConnection, opts: unknown) =>
          leaveChannel(runtime as never, c, opts as never),
      } as never,
      {
        channelName: 'room',
        channelFamily: null,
        target: userRef('user-1'),
        reason: 'revoked',
        revoke: true,
      },
    );

    expect(deleteDurableMembership).toHaveBeenCalledTimes(1);
    expect(connection.channelMemberships.size).toBe(0);
  });

  it('leaves a non-member connection of the same user id untouched', async () => {
    const connection = makeConnection('conn_1', 'user-1');
    // connection never joined 'room', so it is absent from the channelMembers index.
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const deleteDurableMembership = vi.fn();
    const runtime = makeRuntime(
      channelMembers,
      new Map([[connection.id, connection]]),
      deleteDurableMembership,
    );

    await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: (c: RuntimeConnection, opts: unknown) =>
          leaveChannel(runtime as never, c, opts as never),
      } as never,
      {
        channelName: 'room',
        channelFamily: null,
        target: userRef('user-1'),
        reason: 'revoked',
        revoke: true,
      },
    );

    expect(deleteDurableMembership).not.toHaveBeenCalled();
  });
});
