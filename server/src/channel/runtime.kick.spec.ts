/* oxlint-disable @typescript-eslint/no-explicit-any */
import { addChannelMembership, kickChannelMembers, leaveChannel } from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { BroadcastToChannelOptions } from '~/channel/runtime.ts';

function createConnection(id: string) {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
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
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const kept = createConnection('keeper');
    const banned = createConnection('banned');
    const alsoBanned = createConnection('also_banned');

    addChannelMembership(channelMembers, kept, { channelName: 'room:general', channelScope: null });
    addChannelMembership(channelMembers, banned, {
      channelName: 'room:general',
      channelScope: null,
    });
    addChannelMembership(channelMembers, alsoBanned, {
      channelName: 'room:general',
      channelScope: null,
    });
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
        { event, payload, wskit }: SendProtocolMessageOptions,
      ) {
        protocol.push({ connectionId: c.id, event, payload, wskit });
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
      isChannelPersistent: () => false,
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
          __wskit: 'tag-ref' as const,
          kind: 'ephemeral' as const,
          group: 'user',
          key: 'troll',
        },
        reason: 'spam',
        channelScope: null,
      },
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
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const banned = createConnection('banned');
    const alsoBanned = createConnection('also_banned');
    addChannelMembership(channelMembers, banned, {
      channelName: 'room:general',
      channelScope: null,
    });
    addChannelMembership(channelMembers, alsoBanned, {
      channelName: 'room:general',
      channelScope: null,
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
      resumableStreams: new Map(),
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
      isChannelPersistent: () => false,
      persistMembership() {},
      deleteDurableMembership() {},
    };

    await expect(
      kickChannelMembers(
        {
          ...runtime,
          leaveChannel: async (connection: any, opts: any) =>
            leaveChannel(runtime as any, connection, opts),
        } as any,
        {
          channelName: 'room:general',
          target: {
            __wskit: 'tag-ref' as const,
            kind: 'ephemeral' as const,
            group: 'user',
            key: 'troll',
          },
          reason: 'spam',
          channelScope: null,
        },
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

  it('kick on persistent channel with missing compiled family must delete durable membership row', async () => {
    // The channel family key exists in `channelScope` but is absent from
    // `compiled.channelFamilies`.  resolveCompiledChannel returns undefined,
    // which today makes leaveChannel treat the channel as non-persistent and
    // skip deleteDurableMembership. The correct behaviour is to still delete
    // the row so the member cannot auto-rejoin after being kicked.
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const banned = createConnection('banned');

    // Use a dynamic channel family scope so channelScope is non-null.
    addChannelMembership(channelMembers, banned, {
      channelName: 'room:123',
      channelScope: 'room',
    });
    banned.tags.ephemeral.set('role', new Set(['spammer']));

    const connections = new Map([[banned.id, banned]]);

    const deletedRows: { identity: string; channelName: string; channelScope: string | null }[] =
      [];

    // channelFamilies is intentionally EMPTY — simulates the family missing at
    // kick time (e.g. a hot-reload removed it while a member was still live).
    const runtime = {
      compiled: {
        channels: new Map(),
        channelFamilies: new Map(), // family 'room' is NOT registered
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
      sendProtocolMessage() {},
      broadcastToChannel() {},
      async handleValidationError() {},
      // The channel IS persistent — isChannelPersistent would return true for
      // any key associated with this family if the family were present.
      isChannelPersistent: (_key: string) => true,
      persistMembership() {},
      deleteDurableMembership(identity: string, channelName: string, channelScope: string | null) {
        deletedRows.push({ identity, channelName, channelScope });
      },
      hasDurableMembership: () => true,
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
          __wskit: 'tag-ref' as const,
          kind: 'ephemeral' as const,
          group: 'role',
          key: 'spammer',
        },
        reason: 'spam',
        channelScope: 'room',
      },
    );

    // The durable membership row must be deleted so the kicked member cannot
    // auto-rejoin.  Today this fails because an undefined compiled family
    // makes leaveChannel set isPersistent=false and skip deleteDurableMembership.
    expect(deletedRows).toHaveLength(1);
    expect(deletedRows[0]).toEqual({
      identity: 'banned',
      channelName: 'room:123',
      channelScope: 'room',
    });
  });
});
