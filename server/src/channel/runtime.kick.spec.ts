/* oxlint-disable @typescript-eslint/no-explicit-any */
import { addChannelMembership, kickChannelMembers, leaveChannel } from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';

function createConnection(id: string) {
  return {
    id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: new Set<string>(),
    channelMemberships: new Map(),
    latency: null,
    quality: 'good' as const,
  };
}

describe('channels.kick end-to-end', () => {
  it('kicks tagged members, sends _kicked to them, and broadcasts _memberLeave', async () => {
    const kept = createConnection('keeper');
    const banned = createConnection('banned');
    const alsoBanned = createConnection('also_banned');

    addChannelMembership(kept, 'room:general');
    addChannelMembership(banned, 'room:general');
    addChannelMembership(alsoBanned, 'room:general');
    banned.tags.add('troll');
    alsoBanned.tags.add('troll');

    const protocol: { connectionId: string; event: string; payload: any }[] = [];
    const broadcasts: {
      channelName: string;
      event: string;
      payload: any;
      excludeConnectionId?: string;
    }[] = [];

    const generalChannel = {
      key: 'room:general',
      kind: 'channel' as const,
      pattern: 'room:general',
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      preIntercepts: [],
      postIntercepts: new Map(),
    };

    const connections = new Map([
      [kept.id, kept],
      [banned.id, banned],
      [alsoBanned.id, alsoBanned],
    ]);

    const runtime = {
      compiled: {
        channels: new Map([['room:general', generalChannel]]),
        channelFamilies: new Map(),
      },
      connections,
      beforeSubscribeHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map(),
      toConnectionInfo(c: ReturnType<typeof createConnection>) {
        return {
          id: c.id,
          meta: c.meta,
          tags: [...c.tags],
          channels: [...c.channelMemberships.values()].map((m) => m.channelName),
          latency: null,
          quality: 'good' as const,
          bufferedAmount: 0,
        };
      },
      buildConnectionContext(c: ReturnType<typeof createConnection>) {
        return { id: c.id };
      },
      persistAttachment() {},
      sendProtocolMessage(c: ReturnType<typeof createConnection>, event: string, payload: any) {
        protocol.push({ connectionId: c.id, event, payload });
      },
      broadcastToChannel(
        channelName: string,
        event: string,
        payload: any,
        excludeConnectionId?: string,
      ) {
        broadcasts.push({ channelName, event, payload, excludeConnectionId });
      },
      async handleValidationError() {},
    };

    await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: async (connection: any, scope: any, kickedReason: any) =>
          leaveChannel(runtime as any, connection, scope, kickedReason),
      } as any,
      'room:general',
      'troll',
      'spam',
    );

    const kicked = protocol.filter((p) => p.event === '_kicked');
    expect(kicked).toHaveLength(2);
    expect(kicked.every((p) => p.payload.reason === 'spam')).toBe(true);
    expect(new Set(kicked.map((p) => p.connectionId))).toEqual(new Set(['banned', 'also_banned']));

    const memberLeaves = broadcasts.filter((b) => b.event === '_memberLeave');
    expect(memberLeaves).toHaveLength(2);
    expect(new Set(memberLeaves.map((b) => b.excludeConnectionId))).toEqual(
      new Set(['banned', 'also_banned']),
    );

    // Kept connection still a member.
    expect(
      [...kept.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
    expect(
      [...banned.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(false);
    expect(
      [...alsoBanned.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(false);
  });

  it('propagates onUnsubscribe rejections to the kick caller', async () => {
    const banned = createConnection('banned');
    addChannelMembership(banned, 'room:general');
    banned.tags.add('troll');

    const generalChannel = {
      key: 'room:general',
      kind: 'channel' as const,
      pattern: 'room:general',
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      preIntercepts: [],
      postIntercepts: new Map(),
    };

    const connections = new Map([[banned.id, banned]]);

    const runtime = {
      compiled: {
        channels: new Map([['room:general', generalChannel]]),
        channelFamilies: new Map(),
      },
      connections,
      beforeSubscribeHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map([
        [
          'room:general',
          [
            async () => {
              throw new Error('hook boom');
            },
          ],
        ],
      ]),
      toConnectionInfo() {
        return {} as any;
      },
      buildConnectionContext() {
        return {} as any;
      },
      persistAttachment() {},
      sendProtocolMessage() {},
      broadcastToChannel() {},
      async handleValidationError() {},
    };

    await expect(
      kickChannelMembers(
        {
          ...runtime,
          leaveChannel: async (connection: any, scope: any, kickedReason: any) =>
            leaveChannel(runtime as any, connection, scope, kickedReason),
        } as any,
        'room:general',
        'troll',
        'spam',
      ),
    ).rejects.toThrow('hook boom');
  });
});
