import { addConnectionTag, removeConnectionTag } from '~/_engine/runtime/tag-index.ts';
import { buildGroupHandle } from '~/tags/runtime.ts';
import { bench, describe } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { TagsRuntime } from '~/tags/runtime.ts';

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

function setup(taggedCount: number, totalConnections: number) {
  const connections = new Map<string, RuntimeConnection>();
  const tagMembers = new Map<string, Set<RuntimeConnection>>();
  for (let i = 0; i < totalConnections; i++) {
    const connection = createConnection(`c${i}`);
    connections.set(connection.id, connection);
    if (i < taggedCount) {
      addConnectionTag(tagMembers, connection, { kind: 'ephemeral', group: 'team', key: 'eng' });
    }
  }

  const runtime = {
    tagMembers,
    isTagGroupDeclared: () => true,
    toConnectionInfo: (connection: RuntimeConnection) => ({ id: connection.id }),
    sendThroughPipeline: () => {},
    persistAttachment: () => {},
    getStorage: () => ({ sql: { exec: () => ({ toArray: () => [] }) } }),
  } as unknown as TagsRuntime;

  const owner = connections.values().next().value!;

  return { connections, runtime, owner };
}

for (const [taggedCount, total] of [
  [10, 5000],
  [100, 5000],
] as Array<[number, number]>) {
  describe(`tag fan-out · ${taggedCount} tagged of ${total} connections`, () => {
    const { connections, runtime, owner } = setup(taggedCount, total);
    const refHandle = buildGroupHandle(runtime, owner, { kind: 'ephemeral', group: 'team' }).ref(
      'eng',
    );

    bench('tag-ref broadcast · index (F4)', () => {
      refHandle.broadcast('evt', { text: 'hi' });
    });

    // Faithful copy of the pre-F4 implementation — a full connections scan.
    bench('tag-ref broadcast · full scan (before F4)', () => {
      for (const connection of connections.values()) {
        if (connection.tags.ephemeral.get('team')?.has('eng')) {
          // sendThroughPipeline is a no-op stub; the scan is the measured cost.
        }
      }
    });
  });
}

// Tag add/remove maintains two index entries per tag (the group and the ref), so
// a churn loop isolates the cost of building those two keys.
describe('tag index churn · 1000 add/remove cycles', () => {
  const tagMembers = new Map<string, Set<RuntimeConnection>>();
  const connections: RuntimeConnection[] = [];
  for (let i = 0; i < 1000; i++) connections.push(createConnection(`t${i}`));

  bench('add then remove one ephemeral tag per connection', () => {
    for (const connection of connections) {
      addConnectionTag(tagMembers, connection, { kind: 'ephemeral', group: 'team', key: 'eng' });
    }

    for (const connection of connections) {
      removeConnectionTag(tagMembers, connection, { kind: 'ephemeral', group: 'team', key: 'eng' });
    }
  });
});
