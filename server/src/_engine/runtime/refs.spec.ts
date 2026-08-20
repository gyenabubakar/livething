/* oxlint-disable @typescript-eslint/no-explicit-any */
import { buildConnectionHandle } from '~/_engine/runtime/refs.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string, userId: string = id): RuntimeConnection {
  return {
    id,
    userId,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount() {
        return 0;
      },
      userId,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  } as any;
}

function localRef(id: string, userId: string = id) {
  return { __wskit: 'connection-ref' as const, id, instance: undefined, userId };
}

function baseDeps(connections: RuntimeConnection[], overrides: Record<string, unknown> = {}) {
  return {
    connections: new Map(connections.map((c) => [c.id, c])),
    instanceId: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sendThroughPipeline: vi.fn(() => true),
    ...overrides,
  } as any;
}

describe('ctx.connections.get(ref).close', () => {
  it('closes exactly the addressed connection and leaves the rest untouched', () => {
    const self = createConnection('self');
    const peer = createConnection('peer');
    const deps = baseDeps([self, peer]);

    const handle = buildConnectionHandle(deps).connection(localRef('peer'));
    (handle as any).close(4000, 'bye');

    expect(peer.descriptor.close).toHaveBeenCalledWith(4000, 'bye');
    expect(self.descriptor.close).not.toHaveBeenCalled();
  });

  it('does not close the addressed connection when the ref names an id no longer live', () => {
    const self = createConnection('self');
    const deps = baseDeps([self]);

    const handle = buildConnectionHandle(deps).connection(localRef('gone'));
    (handle as any).close(4000, 'bye');

    expect(self.descriptor.close).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
