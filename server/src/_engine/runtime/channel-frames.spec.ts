import { getChannelMembers } from '~/_engine/runtime/channel-frames.ts';
import { addChannelMembership } from '~/channel/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map<string, { channelName: string; channelFamily: string | null }>(),
    latency: null,
    quality: 'good',
  };
}

interface AddMembershipOptions {
  channelName: string;
  channelFamily?: string | null;
}

function addMembership(
  channelMembers: Map<string, Set<RuntimeConnection>>,
  connection: ReturnType<typeof createConnection>,
  { channelName, channelFamily = null }: AddMembershipOptions,
) {
  addChannelMembership(channelMembers, connection, { channelName, channelFamily });
}

function memberRuntime(
  connections: RuntimeConnection[],
  channelMembers: Map<string, Set<RuntimeConnection>>,
) {
  return {
    connections: new Map(connections.map((connection) => [connection.id, connection])),
    channelMembers,
    toConnectionInfo: (c: RuntimeConnection) => ({
      id: c.id,
      identity: c.identity,
      meta: c.meta,
      tags: [],
      channels: [...c.channelMemberships.values()].map((m) => m.channelName),
      latency: null,
      quality: 'good' as const,
      bufferedAmount: 0,
      ref: () => ({
        __wskit: 'connection-ref' as const,
        id: c.id,
        instance: undefined,
        identity: c.identity,
      }),
    }),
  };
}

describe('getChannelMembers scope isolation', () => {
  it('returns only static members when called with null scope', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const staticMember = createConnection('static');
    const familyMember = createConnection('family');
    addMembership(channelMembers, staticMember, { channelName: 'lobby', channelFamily: null });
    addMembership(channelMembers, familyMember, { channelName: 'lobby', channelFamily: 'rooms' });

    const runtime = memberRuntime([staticMember, familyMember], channelMembers);

    const result = getChannelMembers(
      runtime as unknown as Parameters<typeof getChannelMembers>[0],
      'lobby',
      null,
    );
    expect(result.map((r) => r.id)).toEqual(['static']);
  });

  it('returns only the matching family members when called with a family key', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const staticMember = createConnection('static');
    const familyMember = createConnection('family');
    const otherFamilyMember = createConnection('other');
    addMembership(channelMembers, staticMember, { channelName: 'lobby', channelFamily: null });
    addMembership(channelMembers, familyMember, { channelName: 'lobby', channelFamily: 'rooms' });
    addMembership(channelMembers, otherFamilyMember, {
      channelName: 'lobby',
      channelFamily: 'lobbies',
    });

    const runtime = memberRuntime([staticMember, familyMember, otherFamilyMember], channelMembers);

    const result = getChannelMembers(
      runtime as unknown as Parameters<typeof getChannelMembers>[0],
      'lobby',
      'rooms',
    );
    expect(result.map((r) => r.id)).toEqual(['family']);
  });
});
