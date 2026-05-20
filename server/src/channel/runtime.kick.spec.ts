/* oxlint-disable @typescript-eslint/no-explicit-any */
import { addChannelMembership, kickChannelMembers, leaveChannel } from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';

function createConnection(id: string) {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
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

    addChannelMembership(kept, 'room:general', null);
    addChannelMembership(banned, 'room:general', null);
    addChannelMembership(alsoBanned, 'room:general', null);
    banned.tags.ephemeral.set('user', new Set(['troll']));
    alsoBanned.tags.ephemeral.set('user', new Set(['troll']));

    const protocol: { connectionId: string; event: string; payload: any; wskit: any }[] = [];
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
      resumableStreams: new Map(),
      recordedStreams: new Map(),
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
      sessionEndHooks: new Map(),
      toConnectionInfo(c: ReturnType<typeof createConnection>) {
        return {
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
        };
      },
      buildConnectionContext(c: ReturnType<typeof createConnection>) {
        return { id: c.id };
      },
      persistAttachment() {},
      sendProtocolMessage(
        c: ReturnType<typeof createConnection>,
        event: string,
        payload: any,
        wskit: any,
      ) {
        protocol.push({ connectionId: c.id, event, payload, wskit });
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
      isChannelPersistent: () => false,
      persistMembership() {},
      deleteDurableMembership() {},
    };

    await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: async (connection: any, scope: any, kickedReason: any) =>
          leaveChannel(runtime as any, connection, scope, kickedReason),
      } as any,
      'room:general',
      { __wskit: 'tag-ref' as const, kind: 'ephemeral' as const, group: 'user', key: 'troll' },
      'spam',
      null,
    );

    const kicked = protocol.filter((p) => p.event === '__kicked__');
    expect(kicked).toHaveLength(2);
    expect(kicked.every((p) => p.payload.reason === 'spam')).toBe(true);
    expect(kicked.every((p) => p.wskit.channel === 'room:general')).toBe(true);
    expect(new Set(kicked.map((p) => p.connectionId))).toEqual(new Set(['banned', 'also_banned']));

    const memberLeaves = broadcasts.filter((b) => b.event === '__memberLeave__');
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

  it('logs every onUnsubscribe failure and never rejects the caller, even with multiple throwing members', async () => {
    const banned = createConnection('banned');
    const alsoBanned = createConnection('also_banned');
    addChannelMembership(banned, 'room:general', null);
    addChannelMembership(alsoBanned, 'room:general', null);
    banned.tags.ephemeral.set('user', new Set(['troll']));
    alsoBanned.tags.ephemeral.set('user', new Set(['troll']));

    const generalChannel = {
      key: 'room:general',
      kind: 'channel' as const,
      pattern: 'room:general',
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      preIntercepts: [],
      postIntercepts: new Map(),
    };

    const connections = new Map([
      [banned.id, banned],
      [alsoBanned.id, alsoBanned],
    ]);

    const logged: { message: string; fields?: Record<string, unknown> }[] = [];

    let hookCalls = 0;
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
              hookCalls += 1;
              throw new Error(`hook boom ${hookCalls}`);
            },
          ],
        ],
      ]),
      sessionEndHooks: new Map(),
      logger: {
        error(message: string, fields?: Record<string, unknown>) {
          logged.push({ message, fields });
        },
      },
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
      isChannelPersistent: () => false,
      persistMembership() {},
      deleteDurableMembership() {},
    };

    await expect(
      kickChannelMembers(
        {
          ...runtime,
          leaveChannel: async (connection: any, scope: any, kickedReason: any) =>
            leaveChannel(runtime as any, connection, scope, kickedReason),
        } as any,
        'room:general',
        { __wskit: 'tag-ref' as const, kind: 'ephemeral' as const, group: 'user', key: 'troll' },
        'spam',
        null,
      ),
    ).resolves.toBeUndefined();

    const kickErrors = logged.filter((l) => l.message.includes('leaveChannel threw during kick'));
    expect(kickErrors).toHaveLength(2);
    expect(new Set(kickErrors.map((l) => l.fields?.connectionId))).toEqual(
      new Set(['banned', 'also_banned']),
    );
    expect(banned.channelMemberships.size).toBe(0);
    expect(alsoBanned.channelMemberships.size).toBe(0);
  });
});
