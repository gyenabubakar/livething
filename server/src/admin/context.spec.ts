import { ADMIN_CONTEXT_MEMBERS, createAdminContext } from '~/admin/context.ts';
import { describe, expect, it, vi } from 'vitest';
import type { CreateAdminContextDeps } from '~/admin/context.ts';
import type * as PublicApi from '~/context.ts';

/** A stub connection carrying just the fields the admin context reads. */
function conn(id: string, userId: string) {
  return { id, userId, descriptor: { close: vi.fn() } };
}

function makeDeps(overrides: Partial<CreateAdminContextDeps> = {}) {
  const connections = new Map<string, ReturnType<typeof conn>>([
    ['c1', conn('c1', 'alice')],
    ['c2', conn('c2', 'bob')],
    ['c3', conn('c3', 'alice')],
  ]);
  const deps = {
    connections,

    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    platform: {},
    getStorage: () => ({}) as never,
    getStorageView: () => ({}) as never,
    broadcastToConnections: vi.fn(),
    broadcastToChannel: vi.fn(),
    getChannelMembers: vi.fn(() => []),
    kickChannelMembers: vi.fn(() => Promise.resolve()),
    resolveChannel: vi.fn((target: unknown) => {
      if (target === 'missing') return undefined;

      if (typeof target === 'string') {
        return { channelName: target, channelFamily: null, params: {} };
      }

      const { family, name } = target as { family: string; name: string };
      return { channelName: name, channelFamily: family, params: {} };
    }),
    toConnectionInfo: (c: ReturnType<typeof conn>) => ({ id: c.id, userId: c.userId }),
    scheduleTask: vi.fn(),
    cancelScheduled: vi.fn(() => ({ removed: 1, taskExists: true })),
    purgeUser: vi.fn(() => Promise.resolve()),
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
    expect([...(conns as Iterable<unknown>)]).toHaveLength(3);

    expect(opts).toEqual({ event: 'ping', payload: { n: 1 } });
  });

  it('closeConnections({ userId }) closes only that user, else everyone', () => {
    const { deps, connections } = makeDeps();
    const ctx = createAdminContext(deps);

    ctx.closeConnections({ userId: 'alice' }, 4000, 'gone');
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

  it('channels.get(family, instance) resolves a dynamic channel and kick revokes membership', () => {
    const { deps } = makeDeps();
    const target: PublicApi.UserRef = { __wskit: 'user-ref', id: 'alice', instance: undefined };
    createAdminContext(deps)
      .channels.get('rooms', 'rooms:42')
      .kick(target, { reason: 'banned', revoke: true });
    expect(deps.kickChannelMembers).toHaveBeenCalledWith({
      channelName: 'rooms:42',
      channelFamily: 'rooms',
      target,
      reason: 'banned',
      revoke: true,
    });
  });

  it('channels.get(unknown) throws', () => {
    const { deps } = makeDeps();
    expect(() => createAdminContext(deps).channels.get('missing')).toThrow();
  });

  it('purgeUser delegates to the wired closure', async () => {
    const { deps } = makeDeps();
    await createAdminContext(deps).purgeUser('alice');
    expect(deps.purgeUser).toHaveBeenCalledWith('alice');
  });

  it('connectionCount and connections.all reflect the live map', () => {
    const { deps } = makeDeps();
    const ctx = createAdminContext(deps);
    expect(ctx.connectionCount).toBe(3);
    expect(ctx.connections.all().map((c) => c.userId)).toEqual(['alice', 'bob', 'alice']);
  });

  it('connectionCount re-reads the map instead of freezing at build time', () => {
    const { deps } = makeDeps();
    const ctx = createAdminContext(deps);
    expect(ctx.connectionCount).toBe(3);

    (deps.connections as Map<string, unknown>).delete('c2');

    expect(ctx.connectionCount).toBe(2);
  });
});

describe('ADMIN_CONTEXT_MEMBERS', () => {
  it('names every member the admin context actually builds', () => {
    const { deps } = makeDeps();
    const ctx = createAdminContext(deps);

    expect([...Object.keys(ctx)].sort()).toEqual([...ADMIN_CONTEXT_MEMBERS].sort());
  });
});
