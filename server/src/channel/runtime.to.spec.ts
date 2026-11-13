import {
  addChannelMembership,
  matchesRecipient,
  resolveChannelRecipients,
} from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ChannelRecipient } from '~/channel/runtime.ts';

function createConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    socketKey: Symbol(id),
    descriptor: {
      send() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

describe('resolveChannelRecipients — channel-scoped `to` targeting', () => {
  it('a ConnectionRef targets exactly one member and excludes a non-member', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const alice = createConnection('alice-tab1', 'alice');
    addChannelMembership(channelMembers, alice, { channelName: 'room', channelFamily: null });

    const to: ChannelRecipient = {
      __livething: 'connection-ref',
      id: 'alice-tab1',
      instance: undefined,
      userId: 'alice',
    };

    expect(
      resolveChannelRecipients(channelMembers, { channelName: 'room', channelFamily: null, to }),
    ).toEqual([alice]);

    const nonMember: ChannelRecipient = {
      __livething: 'connection-ref',
      id: 'bob-tab1',
      instance: undefined,
      userId: 'bob',
    };

    expect(
      resolveChannelRecipients(channelMembers, {
        channelName: 'room',
        channelFamily: null,
        to: nonMember,
      }),
    ).toEqual([]);
  });

  it("a UserRef fans to only that user's sockets that are members — non-member tabs excluded", () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const aliceTab1 = createConnection('alice-tab1', 'alice');
    // alice-tab2 is deliberately never created/joined — only tab1 and bob subscribe.
    const bob = createConnection('bob-tab1', 'bob');
    addChannelMembership(channelMembers, aliceTab1, { channelName: 'room', channelFamily: null });
    addChannelMembership(channelMembers, bob, { channelName: 'room', channelFamily: null });

    const to: ChannelRecipient = { __livething: 'user-ref', id: 'alice', instance: undefined };
    const resolved = resolveChannelRecipients(channelMembers, {
      channelName: 'room',
      channelFamily: null,
      to,
    });

    expect(resolved).toEqual([aliceTab1]);
  });

  it('a UserRef pointing at a non-member user resolves to an empty list', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const bob = createConnection('bob-tab1', 'bob');
    addChannelMembership(channelMembers, bob, { channelName: 'room', channelFamily: null });

    const to: ChannelRecipient = { __livething: 'user-ref', id: 'carol', instance: undefined };
    expect(
      resolveChannelRecipients(channelMembers, { channelName: 'room', channelFamily: null, to }),
    ).toEqual([]);
  });

  it('a TagRef intersects with membership — a tagged non-member is excluded', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const taggedMember = createConnection('c1', 'u1');
    const taggedNonMember = createConnection('c2', 'u2');
    const untaggedMember = createConnection('c3', 'u3');

    taggedMember.tags.ephemeral.set('role', new Set(['mod']));
    taggedNonMember.tags.ephemeral.set('role', new Set(['mod']));

    addChannelMembership(channelMembers, taggedMember, {
      channelName: 'room',
      channelFamily: null,
    });
    addChannelMembership(channelMembers, untaggedMember, {
      channelName: 'room',
      channelFamily: null,
    });
    // taggedNonMember deliberately never joins the channel.

    const to: ChannelRecipient = {
      __livething: 'tag-ref',
      kind: 'ephemeral',
      group: 'role',
      key: 'mod',
    };

    const resolved = resolveChannelRecipients(channelMembers, {
      channelName: 'room',
      channelFamily: null,
      to,
    });

    expect(resolved).toEqual([taggedMember]);
  });

  it('a group-handle (any key under kind+group) intersects with membership the same way', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const memberWithAnyTagKey = createConnection('c1', 'u1');
    memberWithAnyTagKey.tags.persistent.set('team', new Set(['red']));
    const memberWithoutTag = createConnection('c2', 'u2');

    addChannelMembership(channelMembers, memberWithAnyTagKey, {
      channelName: 'room',
      channelFamily: null,
    });
    addChannelMembership(channelMembers, memberWithoutTag, {
      channelName: 'room',
      channelFamily: null,
    });

    const to: ChannelRecipient = { __livething: 'group-handle', kind: 'persistent', group: 'team' };
    const resolved = resolveChannelRecipients(channelMembers, {
      channelName: 'room',
      channelFamily: null,
      to,
    });

    expect(resolved).toEqual([memberWithAnyTagKey]);
  });

  it('a recipient with no channel members at all resolves to an empty list', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const to: ChannelRecipient = { __livething: 'user-ref', id: 'alice', instance: undefined };
    expect(
      resolveChannelRecipients(channelMembers, {
        channelName: 'empty-room',
        channelFamily: null,
        to,
      }),
    ).toEqual([]);
  });
});

describe('matchesRecipient', () => {
  it('ConnectionRef matches by connection id regardless of userId on the ref', () => {
    const conn = createConnection('c1', 'u1');
    expect(
      matchesRecipient(conn, {
        __livething: 'connection-ref',
        id: 'c1',
        instance: undefined,
        userId: 'someone-else',
      }),
    ).toBe(true);
  });

  it('UserRef matches by userKeyOf(connection), not connection id', () => {
    const conn = createConnection('c1', 'u1');
    expect(matchesRecipient(conn, { __livething: 'user-ref', id: 'u1', instance: undefined })).toBe(
      true,
    );
    expect(matchesRecipient(conn, { __livething: 'user-ref', id: 'c1', instance: undefined })).toBe(
      false,
    );
  });
});
