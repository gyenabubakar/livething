import { getChannelMembers } from '~/_engine/runtime/channel-frames.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map<string, { channelName: string; channelScope: string | null }>(),
    latency: null,
    quality: 'good',
  };
}

function addMembership(
  connection: ReturnType<typeof createConnection>,
  channelName: string,
  channelScope: string | null = null,
) {
  connection.channelMemberships.set(createChannelMembershipKey(channelName, channelScope), {
    channelName,
    channelScope,
  });
}

function memberRuntime(connections: RuntimeConnection[]) {
  return {
    connections: new Map(connections.map((connection) => [connection.id, connection])),
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
    const staticMember = createConnection('static');
    const familyMember = createConnection('family');
    addMembership(staticMember, 'lobby', null);
    addMembership(familyMember, 'lobby', 'rooms');

    const runtime = memberRuntime([staticMember, familyMember]);

    const result = getChannelMembers(
      runtime as unknown as Parameters<typeof getChannelMembers>[0],
      'lobby',
      null,
    );
    expect(result.map((r) => r.id)).toEqual(['static']);
  });

  it('returns only the matching family members when called with a family key', () => {
    const staticMember = createConnection('static');
    const familyMember = createConnection('family');
    const otherFamilyMember = createConnection('other');
    addMembership(staticMember, 'lobby', null);
    addMembership(familyMember, 'lobby', 'rooms');
    addMembership(otherFamilyMember, 'lobby', 'lobbies');

    const runtime = memberRuntime([staticMember, familyMember, otherFamilyMember]);

    const result = getChannelMembers(
      runtime as unknown as Parameters<typeof getChannelMembers>[0],
      'lobby',
      'rooms',
    );
    expect(result.map((r) => r.id)).toEqual(['family']);
  });
});
