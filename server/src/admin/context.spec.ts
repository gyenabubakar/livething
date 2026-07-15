import { createAdminContext } from '~/admin/context.ts';
import { describe, expect, it, vi } from 'vitest';
import type { CreateAdminContextDeps } from '~/admin/context.ts';

/** A stub connection carrying just the fields the admin context reads. */
function conn(id: string, identity: string) {
  return { id, identity, descriptor: { close: vi.fn() } };
}

function makeDeps(overrides: Partial<CreateAdminContextDeps> = {}) {
  const connections = new Map<string, ReturnType<typeof conn>>([
    ['c1', conn('c1', 'alice')],
    ['c2', conn('c2', 'bob')],
    ['c3', conn('c3', 'alice')],
  ]);
  const deps = {
    connections,
    env: {},
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    platform: {},
    waitUntilImpl: vi.fn(),
    requireStorage: () => ({}) as never,
    broadcastToConnections: vi.fn(),
    broadcastToChannel: vi.fn(),
    getChannelMembers: vi.fn(() => []),
    kickChannelMembers: vi.fn(() => Promise.resolve()),
    removeChannelMember: vi.fn(() => Promise.resolve()),
    resolveChannel: vi.fn((target: unknown) => {
      if (target === 'missing') return undefined;
      if (typeof target === 'string') {
        return { channelName: target, channelFamily: null, params: {} };
      }
      const { family, name } = target as { family: string; name: string };
      return { channelName: name, channelFamily: family, params: {} };
    }),
    toConnectionInfo: (c: ReturnType<typeof conn>) => ({ id: c.id, identity: c.identity }),
    scheduleTask: vi.fn(),
    cancelScheduled: vi.fn(() => ({ removed: 1, taskExists: true })),
    purgeIdentity: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as unknown as CreateAdminContextDeps;
  return { deps, connections };
}

describe('createAdminContext', () => {
  it('broadcast fans out to every live connection', () => {
    const { deps } = makeDeps();
    createAdminContext(deps).broadcast('ping', { n: 1 });
    expect(deps.broadcastToConnections).toHaveBeenCalledTimes(1);
    const [conns, opts] = (deps.broadcastToConnections as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(conns).toHaveLength(3);
    expect(opts).toEqual({ event: 'ping', payload: { n: 1 } });
  });

  it('closeConnections({ identity }) closes only that identity, else everyone', () => {
    const { deps, connections } = makeDeps();
    const ctx = createAdminContext(deps);

    ctx.closeConnections({ identity: 'alice' }, 4000, 'gone');
    expect(connections.get('c1')!.descriptor.close).toHaveBeenCalledWith(4000, 'gone');
    expect(connections.get('c3')!.descriptor.close).toHaveBeenCalledWith(4000, 'gone');
    expect(connections.get('c2')!.descriptor.close).not.toHaveBeenCalled();

    ctx.closeConnections();
    expect(connections.get('c2')!.descriptor.close).toHaveBeenCalledTimes(1);
  });

  it('channels.get(name).broadcast resolves the channel and fans out to it', () => {
    const { deps } = makeDeps();
    createAdminContext(deps).channels.get('room').broadcast('tick', { t: 1 });
    expect(deps.broadcastToChannel).toHaveBeenCalledWith({
      channelName: 'room',
      channelFamily: null,
      event: 'tick',
      payload: { t: 1 },
      excludeConnectionId: undefined,
    });
  });

  it('channels.get(family, instance) resolves a dynamic channel', () => {
    const { deps } = makeDeps();
    createAdminContext(deps).channels.get('rooms', 'rooms:42').removeMember('alice');
    expect(deps.removeChannelMember).toHaveBeenCalledWith('rooms:42', 'rooms', 'alice');
  });

  it('channels.get(unknown) throws', () => {
    const { deps } = makeDeps();
    expect(() => createAdminContext(deps).channels.get('missing')).toThrow();
  });

  it('purgeIdentity delegates to the wired closure', async () => {
    const { deps } = makeDeps();
    await createAdminContext(deps).purgeIdentity('alice');
    expect(deps.purgeIdentity).toHaveBeenCalledWith('alice');
  });

  it('connectionCount and getConnections reflect the live map', () => {
    const { deps } = makeDeps();
    const ctx = createAdminContext(deps);
    expect(ctx.connectionCount).toBe(3);
    expect(ctx.getConnections().map((c) => c.identity)).toEqual(['alice', 'bob', 'alice']);
  });
});
