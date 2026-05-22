import { addChannelMembership } from '~/channel/runtime.ts';
import { broadcastToChannel } from '~/outgoing/runtime.ts';
import { bench, describe } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { broadcastToChannel as BroadcastToChannel } from '~/outgoing/runtime.ts';

type ChannelRuntimeArg = Parameters<typeof BroadcastToChannel>[0];

function createConnection(id: string): RuntimeConnection {
  const connection: RuntimeConnection = {
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
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
  addChannelMembership(connection, 'room', null);
  return connection;
}

function createRuntime(memberCount: number): ChannelRuntimeArg {
  const connections = new Map<string, RuntimeConnection>();
  for (let i = 0; i < memberCount; i++) {
    const connection = createConnection(`c${i}`);
    connections.set(connection.id, connection);
  }

  let seq = 0;
  const runtime = {
    compiled: {
      outgoing: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      namespaces: new Map(),
      channels: new Map([
        [
          'room',
          {
            outgoing: new Map([['chat', { event: 'chat' }]]),
            streams: new Map(),
            resumableStreams: new Map(),
            recordedStreams: new Map(),
          },
        ],
      ]),
      channelFamilies: new Map(),
      modules: [],
    },
    connections,
    moduleRuntimes: [],
    outgoingHooks: [
      (message: { event: string; payload: unknown }) => message.payload,
      () => undefined,
    ],
    wskitStampHooks: [() => ({ seq: seq++ })],
    beforeSendHooks: [],
    afterSendHooks: [],
    waitUntil() {},
    logger: { warn() {}, error() {} },
    generateId: () => 'id',
    toConnectionInfo: (connection: RuntimeConnection) => ({ id: connection.id }),
  };

  return runtime as unknown as ChannelRuntimeArg;
}

const smallPayload = { text: 'hello world' };

const largePayload = {
  text: 'x'.repeat(1800),
  author: 'user-1234',
  roomId: 'room-general',
  tags: ['announcement', 'pinned', 'urgent'],
  reactions: { thumbsUp: 12, heart: 5, fire: 3 },
  mentions: ['user-1', 'user-2', 'user-3', 'user-4'],
};

for (const memberCount of [100, 1000]) {
  describe(`broadcastToChannel · ${memberCount} members`, () => {
    const smallRuntime = createRuntime(memberCount);
    bench('small payload', () => {
      broadcastToChannel(smallRuntime, 'room', 'chat', smallPayload, undefined, null);
    });

    const largeRuntime = createRuntime(memberCount);
    bench('large payload (~2 KB)', () => {
      broadcastToChannel(largeRuntime, 'room', 'chat', largePayload, undefined, null);
    });
  });
}
