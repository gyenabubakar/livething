/* oxlint-disable @typescript-eslint/no-explicit-any */
import { addChannelMembership, kickChannelMembers, leaveChannel } from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { BroadcastToChannelOptions } from '~/channel/runtime.ts';

function createConnection(id: string) {
  return {
    id,
    userId: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      userId: id,
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
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const kept = createConnection('keeper');
    const banned = createConnection('banned');
    const alsoBanned = createConnection('also_banned');

    addChannelMembership(channelMembers, kept, {
      channelName: 'room:general',
      channelFamily: null,
    });
    addChannelMembership(channelMembers, banned, {
      channelName: 'room:general',
      channelFamily: null,
    });
    addChannelMembership(channelMembers, alsoBanned, {
      channelName: 'room:general',
      channelFamily: null,
    });
    banned.tags.ephemeral.set('user', new Set(['troll']));
    alsoBanned.tags.ephemeral.set('user', new Set(['troll']));

    const protocol: { connectionId: string; event: string; payload: any; livething: any }[] = [];
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
      cursorStreams: new Map(),
      recordedStreams: new Map(),
      intercepts: [],
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
      channelMembers,
      checkHooks: new Map(),
      revalidateHooks: new Map(),
      commitHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map(),
      sessionEndHooks: new Map(),
      toConnectionInfo(c: ReturnType<typeof createConnection>) {
        return {
          id: c.id,
          userId: c.userId,
          meta: c.meta,
          tags: [],
          channels: [...c.channelMemberships.values()].map((m) => m.channelName),
          latency: null,
          quality: 'good' as const,
          bufferedAmount: 0,
          ref: () => ({
            __livething: 'connection-ref' as const,
            id: c.id,
            instance: undefined,
            userId: c.userId,
          }),
        };
      },
      buildConnectionContext(c: ReturnType<typeof createConnection>) {
        return { id: c.id };
      },
      persistAttachment() {},
      sendProtocolMessage(
        c: ReturnType<typeof createConnection>,
        { event, payload, livething }: SendProtocolMessageOptions,
      ) {
        protocol.push({ connectionId: c.id, event, payload, livething });
      },
      broadcastToChannel({
        channelName,
        event,
        payload,
        excludeConnectionId,
      }: BroadcastToChannelOptions) {
        broadcasts.push({ channelName, event, payload, excludeConnectionId });
      },
      async handleValidationError() {},
      isChannelDurable: () => false,
      persistMembership() {},
      deleteDurableMembership() {},
    };

    await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: async (connection: any, opts: any) =>
          leaveChannel(runtime as any, connection, opts),
      } as any,
      {
        channelName: 'room:general',
        target: {
          __livething: 'tag-ref' as const,
          kind: 'ephemeral' as const,
          group: 'user',
          key: 'troll',
        },
        reason: 'spam',
        channelFamily: null,
      },
    );

    const kicked = protocol.filter((p) => p.event === '__kicked__');
    expect(kicked).toHaveLength(2);
    expect(kicked.every((p) => p.payload.reason === 'spam')).toBe(true);
    expect(kicked.every((p) => p.livething.channel === 'room:general')).toBe(true);
    expect(new Set(kicked.map((p) => p.connectionId))).toEqual(new Set(['banned', 'also_banned']));

    const memberLeaves = broadcasts.filter((b) => b.event === '__memberLeave__');
    expect(memberLeaves).toHaveLength(2);
    expect(new Set(memberLeaves.map((b) => b.excludeConnectionId))).toEqual(
      new Set(['banned', 'also_banned']),
    );

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

  it('kicks every member, then rejects with an AggregateError of every onUnsubscribe failure', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const banned = createConnection('banned');
    const alsoBanned = createConnection('also_banned');
    addChannelMembership(channelMembers, banned, {
      channelName: 'room:general',
      channelFamily: null,
    });
    addChannelMembership(channelMembers, alsoBanned, {
      channelName: 'room:general',
      channelFamily: null,
    });

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
      cursorStreams: new Map(),
      recordedStreams: new Map(),
      intercepts: [],
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
      channelMembers,
      checkHooks: new Map(),
      revalidateHooks: new Map(),
      commitHooks: new Map(),
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
      isChannelDurable: () => false,
      persistMembership() {},
      deleteDurableMembership() {},
    };

    const rejection = await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: async (connection: any, opts: any) =>
          leaveChannel(runtime as any, connection, opts),
      } as any,
      {
        channelName: 'room:general',
        target: {
          __livething: 'tag-ref' as const,
          kind: 'ephemeral' as const,
          group: 'user',
          key: 'troll',
        },
        reason: 'spam',
        channelFamily: null,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect(new Set((rejection as AggregateError).errors.map((e: Error) => e.message))).toEqual(
      new Set(['hook boom 1', 'hook boom 2']),
    );

    const hookErrors = logged.filter((l) => l.message.includes('onUnsubscribe hook threw'));
    expect(new Set(hookErrors.map((l) => l.fields?.connectionId))).toEqual(
      new Set(['banned', 'also_banned']),
    );
    expect(banned.channelMemberships.size).toBe(0);
    expect(alsoBanned.channelMemberships.size).toBe(0);
  });

  it('kick on persistent channel with missing compiled family must delete durable membership row', async () => {
    // The channel family key exists in `channelFamily` but is absent from
    // `compiled.channelFamilies`.  resolveCompiledChannel returns undefined,
    // which today makes leaveChannel treat the channel as non-persistent and
    // skip deleteDurableMembership. The correct behaviour is to still delete
    // the row so the member cannot auto-rejoin after being kicked.
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const banned = createConnection('banned');

    addChannelMembership(channelMembers, banned, {
      channelName: 'room:123',
      channelFamily: 'room',
    });
    banned.tags.ephemeral.set('role', new Set(['spammer']));

    const connections = new Map([[banned.id, banned]]);

    const deletedRows: { userId: string; channelName: string; channelFamily: string | null }[] = [];

    // channelFamilies is intentionally EMPTY — simulates the family missing at
    // kick time (e.g. a hot-reload removed it while a member was still live).
    const runtime = {
      compiled: {
        channels: new Map(),
        channelFamilies: new Map(),
      },
      connections,
      channelMembers,
      checkHooks: new Map(),
      revalidateHooks: new Map(),
      commitHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map(),
      sessionEndHooks: new Map(),
      toConnectionInfo(c: ReturnType<typeof createConnection>) {
        return {
          id: c.id,
          userId: c.userId,
          meta: c.meta,
          tags: [],
          channels: [...c.channelMemberships.values()].map((m) => m.channelName),
          latency: null,
          quality: 'good' as const,
          bufferedAmount: 0,
          ref: () => ({
            __livething: 'connection-ref' as const,
            id: c.id,
            instance: undefined,
            userId: c.userId,
          }),
        };
      },
      buildConnectionContext(c: ReturnType<typeof createConnection>) {
        return { id: c.id };
      },
      persistAttachment() {},
      sendProtocolMessage() {},
      broadcastToChannel() {},
      async handleValidationError() {},
      isChannelDurable: (_key: string) => true,
      persistMembership() {},
      deleteDurableMembership(userId: string, channelName: string, channelFamily: string | null) {
        deletedRows.push({ userId, channelName, channelFamily });
      },
      getDurableMembership: () => ({ meta: {}, kicked: false }),
      markDurableMembershipKicked() {},
      listDurableMembers: () => [],
    };

    await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: async (connection: any, opts: any) =>
          leaveChannel(runtime as any, connection, opts),
      } as any,
      {
        channelName: 'room:123',
        target: {
          __livething: 'tag-ref' as const,
          kind: 'ephemeral' as const,
          group: 'role',
          key: 'spammer',
        },
        reason: 'spam',
        channelFamily: 'room',
        revoke: true,
      },
    );

    // The durable membership row must be deleted so the kicked member cannot
    // auto-rejoin.  Today this fails because an undefined compiled family
    // makes leaveChannel set isPersistent=false and skip deleteDurableMembership.
    expect(deletedRows).toHaveLength(1);
    expect(deletedRows[0]).toEqual({
      userId: 'banned',
      channelName: 'room:123',
      channelFamily: 'room',
    });
  });
});
