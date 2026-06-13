import { createChannelMembershipKey } from '~/channel/runtime.ts';
import {
  deleteDurableMembership,
  hasDurableMembership,
  persistMembership,
  removeChannelMember,
} from '~/persistence/membership.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function makeCore(exec: ReturnType<typeof vi.fn>): EngineCore {
  return {
    persistenceEnabled: true,
    requireStorage: () => ({ sql: { exec } }),
  } as unknown as EngineCore;
}

function makeExec() {
  return vi.fn(() => ({ toArray: () => [], one: () => null, raw: () => [] }));
}

describe('durable membership identity gate', () => {
  it('skips the durable write for an empty (anonymous) identity', () => {
    const exec = makeExec();
    persistMembership(makeCore(exec), { identity: '', channelName: 'room', channelScope: null });
    expect(exec).not.toHaveBeenCalled();
  });

  it('writes the durable row for a real identity', () => {
    const exec = makeExec();
    persistMembership(makeCore(exec), {
      identity: 'user-1',
      channelName: 'room',
      channelScope: null,
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('skips the durable delete for an empty identity', () => {
    const exec = makeExec();
    deleteDurableMembership(makeCore(exec), {
      identity: '',
      channelName: 'room',
      channelScope: null,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports no durable membership for an empty identity without querying', () => {
    const exec = makeExec();
    const result = hasDurableMembership(makeCore(exec), {
      identity: '',
      channelName: 'room',
      channelScope: null,
    });
    expect(result).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('removeChannelMember with persistence disabled', () => {
  it('skips the durable delete but still makes the live socket leave', async () => {
    const exec = makeExec();
    const membershipKey = createChannelMembershipKey('room', null);
    const connection = {
      id: 'conn_1',
      identity: 'user-1',
      channelMemberships: new Map([[membershipKey, { channelName: 'room', channelScope: null }]]),
    } as unknown as RuntimeConnection;

    const core = {
      persistenceEnabled: false,
      requireStorage: () => ({ sql: { exec } }),
      compiled: { channels: new Map([['room', { pattern: 'room' }]]), channelFamilies: new Map() },
      connections: new Map([[connection.id, connection]]),
      logger: { error: vi.fn() },
    } as unknown as EngineCore;

    const leaveChannel = vi.fn(async (_connection: RuntimeConnection, _opts: unknown) => {});
    await removeChannelMember(core, leaveChannel, {
      identity: 'user-1',
      channelName: 'room',
      channelScope: null,
    });

    // No durable row to delete with persistence off — no SQL runs.
    expect(exec).not.toHaveBeenCalled();
    // The live connection is still kicked out of the channel (true leave).
    expect(leaveChannel).toHaveBeenCalledTimes(1);
    expect(leaveChannel.mock.calls[0]![0]).toBe(connection);
  });

  it('leaves a non-member connection of the same identity untouched', async () => {
    const exec = makeExec();
    const connection = {
      id: 'conn_1',
      identity: 'user-1',
      channelMemberships: new Map(), // not a member of 'room'
    } as unknown as RuntimeConnection;

    const core = {
      persistenceEnabled: false,
      requireStorage: () => ({ sql: { exec } }),
      compiled: { channels: new Map([['room', { pattern: 'room' }]]), channelFamilies: new Map() },
      connections: new Map([[connection.id, connection]]),
      logger: { error: vi.fn() },
    } as unknown as EngineCore;

    const leaveChannel = vi.fn(async (_connection: RuntimeConnection, _opts: unknown) => {});
    await removeChannelMember(core, leaveChannel, {
      identity: 'user-1',
      channelName: 'room',
      channelScope: null,
    });

    expect(leaveChannel).not.toHaveBeenCalled();
  });
});
