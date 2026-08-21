import { addChannelMembership } from '~/channel/runtime.ts';
import { APP_HOOK_OWNER } from '~/intercept/intercept.ts';
import { broadcastToChannel } from '~/outgoing/runtime.ts';
import { bench, describe } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { broadcastToChannel as BroadcastToChannel } from '~/outgoing/runtime.ts';

type ChannelRuntimeArg = Parameters<typeof BroadcastToChannel>[0];

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
      userId: id,
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createRuntime(
  memberCount: number,
  totalConnections: number,
  withStamper = true,
): ChannelRuntimeArg {
  const connections = new Map<string, RuntimeConnection>();
  const channelMembers = new Map<string, Set<RuntimeConnection>>();
  for (let i = 0; i < totalConnections; i++) {
    const connection = createConnection(`c${i}`);
    connections.set(connection.id, connection);
    if (i < memberCount)
      addChannelMembership(channelMembers, connection, {
        channelName: 'room',
        channelFamily: null,
      });
  }

  let seq = 0;
  const runtime = {
    compiled: {
      outgoing: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
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
    },
    connections,
    channelMembers,
    outgoingHooks: [
      { handler: (message: { payload: unknown }) => message.payload, owner: APP_HOOK_OWNER },
      { handler: () => undefined, owner: APP_HOOK_OWNER },
    ],
    wskitStampHooks: withStamper ? [() => ({ seq: seq++ })] : [],
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

const scenarios: Array<[number, number]> = [
  [100, 100],
  [1000, 1000],
  [10, 5000],
  [100, 5000],
];

for (const [memberCount, total] of scenarios) {
  describe(`broadcastToChannel · ${memberCount} members of ${total} connections`, () => {
    const smallRuntime = createRuntime(memberCount, total);
    bench('small payload', () => {
      broadcastToChannel(smallRuntime, {
        channelName: 'room',
        event: 'chat',
        payload: smallPayload,
        excludeConnectionId: undefined,
        channelFamily: null,
      });
    });

    const largeRuntime = createRuntime(memberCount, total);
    bench('large payload (~2 KB)', () => {
      broadcastToChannel(largeRuntime, {
        channelName: 'room',
        event: 'chat',
        payload: largePayload,
        excludeConnectionId: undefined,
        channelFamily: null,
      });
    });
  });
}

// No sequence/dedup stamper — every recipient's frame is identical, so the
// broadcast can build the frame string once.
for (const [memberCount, total] of [
  [1000, 1000],
  [100, 5000],
] as Array<[number, number]>) {
  describe(`broadcastToChannel · ${memberCount} of ${total} · no stamper`, () => {
    const smallRuntime = createRuntime(memberCount, total, false);
    bench('small payload', () => {
      broadcastToChannel(smallRuntime, {
        channelName: 'room',
        event: 'chat',
        payload: smallPayload,
        excludeConnectionId: undefined,
        channelFamily: null,
      });
    });

    const largeRuntime = createRuntime(memberCount, total, false);
    bench('large payload (~2 KB)', () => {
      broadcastToChannel(largeRuntime, {
        channelName: 'room',
        event: 'chat',
        payload: largePayload,
        excludeConnectionId: undefined,
        channelFamily: null,
      });
    });
  });
}
