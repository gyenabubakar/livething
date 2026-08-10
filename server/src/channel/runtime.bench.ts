import {
  addChannelMembership,
  removeChannelMembership,
  subscribeConnection,
} from '~/channel/runtime.ts';
import { bench, describe } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { subscribeConnection as SubscribeConnection } from '~/channel/runtime.ts';

type ChannelRuntimeArg = Parameters<typeof SubscribeConnection>[0];

function createConnection(id: string): RuntimeConnection {
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
      identity: id,
    },
    meta: { username: id },
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createRuntime(memberCount: number) {
  const connections = new Map<string, RuntimeConnection>();
  const channelMembers = new Map<string, Set<RuntimeConnection>>();
  const channel = {
    key: 'general',
    kind: 'channel' as const,
    pattern: 'general',
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
  };

  for (let i = 0; i < memberCount; i++) {
    const member = createConnection(`m${i}`);
    connections.set(member.id, member);
    addChannelMembership(channelMembers, member, { channelName: 'general', channelFamily: null });
  }

  const runtime = {
    compiled: { channels: new Map([['general', channel]]), channelFamilies: new Map() },
    connections,
    channelMembers,
    checkHooks: new Map(),
    revalidateHooks: new Map(),
    commitHooks: new Map(),
    subscribeHooks: new Map(),
    unsubscribeHooks: new Map(),
    sessionEndHooks: new Map(),
    toConnectionInfo: (connection: RuntimeConnection) => ({
      id: connection.id,
      userId: connection.userId,
      meta: connection.meta,
      tags: [],
      channels: [],
      latency: null,
      quality: 'good' as const,
    }),
    buildConnectionContext: (connection: RuntimeConnection) => ({ id: connection.id }),
    persistAttachment: () => {},
    sendProtocolMessage: (
      _connection: RuntimeConnection,
      { event, payload, wskit }: SendProtocolMessageOptions,
    ) => {
      JSON.stringify({ event, payload, __wskit: wskit });
    },
    broadcastToChannel: () => {},
    wskitStampHooks: [],
    handleValidationError: async () => {},
    handleRuntimeError: async () => {},
    isChannelDurable: () => false,
    persistMembership: () => {},
    deleteDurableMembership: () => {},
    hasDurableMembership: () => false,
    logger: { error() {} },
  };

  return { runtime: runtime as unknown as ChannelRuntimeArg, connections, channelMembers };
}

for (const memberCount of [100, 500]) {
  describe(`subscribeConnection · join a ${memberCount}-member channel`, () => {
    const { runtime, connections, channelMembers } = createRuntime(memberCount);
    let n = 0;

    bench('member-sync to the joining socket', async () => {
      const joiner = createConnection(`j${n++}`);
      connections.set(joiner.id, joiner);
      await subscribeConnection(runtime, joiner, {
        channelName: 'general',
        channelFamily: null,
        data: undefined,
      });
      removeChannelMembership(channelMembers, joiner, {
        channelName: 'general',
        channelFamily: null,
      });
      connections.delete(joiner.id);
    });
  });
}
