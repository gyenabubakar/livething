import { CloseCodes, WSKitConfigError } from '@wskit/core';
import { acceptConnection } from '~/_engine/runtime/connection.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

function baseCompiled(usersPolicy?: { maxConnections?: number; onExceed: 'replace' | 'reject' }) {
  return {
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
    channels: new Map(),
    channelFamilies: new Map(),
    scheduled: new Map(),
    requires: {},
    replayClaimedChannelKeys: new Set(),
    usersPolicy,
  };
}

function createRuntime(
  usersPolicy?: { maxConnections?: number; onExceed: 'replace' | 'reject' },
  overrides: Record<string, unknown> = {},
) {
  let idCounter = 0;
  return {
    compiled: baseCompiled(usersPolicy),
    connections: new Map<string, EngineRuntimeTypes.RuntimeConnection>(),
    usersByKey: new Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>(),
    wsToConnectionId: new Map(),
    channelMembers: new Map(),
    tagMembers: new Map(),
    generateId: () => `conn_${++idCounter}`,
    persistAttachment() {},
    buildConnectionContext(connection: EngineRuntimeTypes.RuntimeConnection) {
      return { id: connection.id };
    },
    async runConnectionLifecycle() {},
    async processTextMessage() {},
    async handleConnectionClose() {},
    async handleRuntimeError() {},
    ...overrides,
  };
}

function descriptorFor(userId: string) {
  return {
    send: vi.fn(),
    close: vi.fn(),
    bufferedAmount: () => 0,
    userId,
  };
}

describe('acceptConnection — users.maxConnections policy', () => {
  it('is unlimited by default: a fourth connection for the same user is admitted', () => {
    const runtime = createRuntime(undefined);
    for (let i = 0; i < 4; i += 1) {
      acceptConnection(runtime as never, Symbol(`ws${i}`), descriptorFor('u1'));
    }
    expect(runtime.usersByKey.get('u1')?.size).toBe(4);
    expect(runtime.connections.size).toBe(4);
  });

  it('onExceed "reject" closes the NEW connection with CAPACITY and never registers it', () => {
    const runtime = createRuntime({ maxConnections: 2, onExceed: 'reject' });
    acceptConnection(runtime as never, Symbol('ws1'), descriptorFor('u1'));
    acceptConnection(runtime as never, Symbol('ws2'), descriptorFor('u1'));

    const thirdDescriptor = descriptorFor('u1');
    acceptConnection(runtime as never, Symbol('ws3'), thirdDescriptor);

    expect(thirdDescriptor.close).toHaveBeenCalledWith(CloseCodes.CAPACITY, expect.any(String));
    expect(runtime.usersByKey.get('u1')?.size).toBe(2);
    expect(runtime.connections.size).toBe(2);
  });

  it('onExceed "replace" evicts the oldest connection with DUPLICATE and admits the newcomer', () => {
    const runtime = createRuntime({ maxConnections: 2, onExceed: 'replace' });
    const first = descriptorFor('u1');
    const second = descriptorFor('u1');
    acceptConnection(runtime as never, Symbol('ws1'), first);
    acceptConnection(runtime as never, Symbol('ws2'), second);

    const third = descriptorFor('u1');
    acceptConnection(runtime as never, Symbol('ws3'), third);

    expect(first.close).toHaveBeenCalledWith(CloseCodes.DUPLICATE, expect.any(String));
    expect(second.close).not.toHaveBeenCalled();
    expect(third.close).not.toHaveBeenCalled();
    // An evicted socket leaves the user-key index the moment it is picked, so
    // the cap holds even before its close lands. It stays in `connections`
    // until the adapter's own close callback arrives — it is still a live
    // socket, just no longer one the user can be reached at.
    expect(runtime.usersByKey.get('u1')?.size).toBe(2);
    expect(runtime.connections.size).toBe(3);
  });

  it('does not evict a healthy connection when the replacement translator factory fails', () => {
    let translatorFactories = 0;
    const runtime = createRuntime(
      { maxConnections: 1, onExceed: 'replace' },
      {
        translatorFactory() {
          translatorFactories += 1;
          if (translatorFactories === 2) throw new Error('invalid translator');
          return { inbound: (raw: string) => raw };
        },
      },
    );
    const first = descriptorFor('u1');
    const rejected = descriptorFor('u1');

    acceptConnection(runtime as never, Symbol('first'), first);
    acceptConnection(runtime as never, Symbol('rejected'), rejected);

    expect(first.close).not.toHaveBeenCalled();
    expect(rejected.close).toHaveBeenCalledWith(1011, '[wskit] translator failed');
    expect(runtime.usersByKey.get('u1')?.size).toBe(1);
  });

  it('reports a malformed direct translator factory as configuration error', () => {
    const runtime = createRuntime(undefined, {
      translatorFactory() {
        return { outbound() {} };
      },
    });
    const descriptor = descriptorFor('u1');

    expect(() =>
      acceptConnection(runtime as never, Symbol('invalid-translator'), descriptor),
    ).toThrow(WSKitConfigError);
    expect(descriptor.close).toHaveBeenCalledWith(1011, '[wskit] translator configuration failed');
    expect(runtime.connections).toHaveLength(0);
  });

  it('replace evicts multiple oldest connections when the newcomer pushes further over the cap', () => {
    const runtime = createRuntime({ maxConnections: 1, onExceed: 'replace' });
    const first = descriptorFor('u1');
    acceptConnection(runtime as never, Symbol('ws1'), first);

    const second = descriptorFor('u1');
    acceptConnection(runtime as never, Symbol('ws2'), second);
    expect(first.close).toHaveBeenCalledWith(CloseCodes.DUPLICATE, expect.any(String));
    expect(runtime.usersByKey.get('u1')?.size).toBe(1);
  });

  it('anonymous connections (empty identity) are never capped, even past maxConnections', () => {
    const runtime = createRuntime({ maxConnections: 1, onExceed: 'reject' });
    for (let i = 0; i < 5; i += 1) {
      const anon = descriptorFor('');
      acceptConnection(runtime as never, Symbol(`ws${i}`), anon);
      expect(anon.close).not.toHaveBeenCalled();
    }
    expect(runtime.connections.size).toBe(5);
  });

  it('replace holds the live count at the cap across a burst, even though close() has not landed yet', () => {
    const runtime = createRuntime({ maxConnections: 1, onExceed: 'replace' });
    const descriptors: ReturnType<typeof descriptorFor>[] = [];
    for (let i = 0; i < 5; i += 1) {
      const descriptor = descriptorFor('u1');
      descriptors.push(descriptor);
      acceptConnection(runtime as never, Symbol(`ws${i}`), descriptor);
      expect(runtime.usersByKey.get('u1')?.size).toBeLessThanOrEqual(1);
    }
    expect(runtime.usersByKey.get('u1')?.size).toBe(1);
    for (const descriptor of descriptors) {
      expect(descriptor.close).toHaveBeenCalledTimes(descriptor === descriptors[4] ? 0 : 1);
    }
  });

  it('the cap is per-user: a second user is unaffected by the first user being at capacity', () => {
    const runtime = createRuntime({ maxConnections: 1, onExceed: 'reject' });
    acceptConnection(runtime as never, Symbol('ws1'), descriptorFor('u1'));

    const otherUserDescriptor = descriptorFor('u2');
    acceptConnection(runtime as never, Symbol('ws2'), otherUserDescriptor);

    expect(otherUserDescriptor.close).not.toHaveBeenCalled();
    expect(runtime.usersByKey.get('u2')?.size).toBe(1);
  });
});
