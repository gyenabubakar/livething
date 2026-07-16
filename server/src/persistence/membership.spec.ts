import { createTestSql } from '~/_test/sql.ts';
import { createChannelMembershipKey, removeChannelMember } from '~/channel/runtime.ts';
import {
  deleteDurableMembership,
  hasDurableMembership,
  persistMembership,
} from '~/persistence/membership.ts';
import { ensurePersistenceSchema } from '~/persistence/storage.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';

function makeCore(sql: SQLProvider): EngineCore {
  return {
    persistenceEnabled: true,
    requireStorage: () => ({ sql }),
  } as unknown as EngineCore;
}

describe('durable membership identity gate', () => {
  it('skips the durable write for an empty (anonymous) identity', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensurePersistenceSchema(sql);
    statements = 0;

    persistMembership(makeCore(sql), { identity: '', channelName: 'room', channelFamily: null });
    expect(statements).toBe(0);
  });

  it('writes the durable row for a real identity', () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);

    persistMembership(makeCore(sql), {
      identity: 'user-1',
      channelName: 'room',
      channelFamily: null,
    });
    expect(
      hasDurableMembership(makeCore(sql), {
        identity: 'user-1',
        channelName: 'room',
        channelFamily: null,
      }),
    ).toBe(true);
  });

  it('skips the durable delete for an empty identity', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensurePersistenceSchema(sql);
    statements = 0;

    deleteDurableMembership(makeCore(sql), {
      identity: '',
      channelName: 'room',
      channelFamily: null,
    });
    expect(statements).toBe(0);
  });

  it('reports no durable membership for an empty identity without querying', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensurePersistenceSchema(sql);
    statements = 0;

    const result = hasDurableMembership(makeCore(sql), {
      identity: '',
      channelName: 'room',
      channelFamily: null,
    });
    expect(result).toBe(false);
    expect(statements).toBe(0);
  });
});

describe('removeChannelMember', () => {
  function makeDeps(connection: RuntimeConnection) {
    return {
      compiled: { channels: new Map([['room', { pattern: 'room' }]]), channelFamilies: new Map() },
      connections: new Map([[connection.id, connection]]),
      logger: { error: vi.fn() },
      deleteDurableMembership: vi.fn(),
    } as unknown as Parameters<typeof removeChannelMember>[0] & {
      deleteDurableMembership: ReturnType<typeof vi.fn>;
    };
  }

  it('drops the durable row and makes the live socket leave', async () => {
    const membershipKey = createChannelMembershipKey('room', null);
    const connection = {
      id: 'conn_1',
      identity: 'user-1',
      channelMemberships: new Map([[membershipKey, { channelName: 'room', channelFamily: null }]]),
    } as unknown as RuntimeConnection;

    const deps = makeDeps(connection);
    const leaveChannel = vi.fn(async (_connection: RuntimeConnection, _opts: unknown) => {});
    await removeChannelMember(deps, leaveChannel, {
      identity: 'user-1',
      channelName: 'room',
      channelFamily: null,
    });

    expect(deps.deleteDurableMembership).toHaveBeenCalledTimes(1);
    expect(leaveChannel).toHaveBeenCalledTimes(1);
    expect(leaveChannel.mock.calls[0]![0]).toBe(connection);
  });

  it('leaves a non-member connection of the same identity untouched', async () => {
    const connection = {
      id: 'conn_1',
      identity: 'user-1',
      channelMemberships: new Map(), // not a member of 'room'
    } as unknown as RuntimeConnection;

    const deps = makeDeps(connection);
    const leaveChannel = vi.fn(async (_connection: RuntimeConnection, _opts: unknown) => {});
    await removeChannelMember(deps, leaveChannel, {
      identity: 'user-1',
      channelName: 'room',
      channelFamily: null,
    });

    expect(leaveChannel).not.toHaveBeenCalled();
  });
});
