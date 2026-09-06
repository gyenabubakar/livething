/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { dispatchIncoming } from '~/_engine/runtime/messages.ts';
import { channels } from '~/channel/capability.ts';
import { channel } from '~/channel/channel.ts';
import { buildChannelFamilyExtra } from '~/channel/context.ts';
import { createChannelMembershipKey, subscribeConnection } from '~/channel/runtime.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox } from '~/inbox/capability.ts';
import { intercepts } from '~/intercept/capability.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { replay } from '~/replay/replay.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { sequence } from '~/sequence/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { plugin } from './plugins.ts';

function findPrimitive(primitives: readonly any[], wskit: string, event?: string): any {
  const found = primitives.find((p) => p.__wskit === wskit && (event ? p.event === event : true));
  if (!found) throw new Error(`no ${wskit} primitive${event ? ` for ${event}` : ''}`);
  return found;
}

/** A small presence-style plugin authored as a scoped handler. */
function buildPresence() {
  const h = define({
    scope: 'plugin',
    capabilities: [
      emits({ 'user-online': t<{ id: string }>() }),
      clientRequests(),
      serverRequests(),
    ],
  });
  const heartbeat = h.on('heartbeat', {
    input: v.object({}),
    run(ctx) {
      ctx.send('user-online', { id: ctx.connection.id });
    },
  });
  const whoIsHere = h.request('who-is-here', {
    input: v.object({}),
    run() {
      return { users: [] as string[] };
    },
  });
  return plugin('acme:presence', {
    handler: h.assemble({
      handlers: [heartbeat, whoIsHere],
      api: (ctx) => ({
        announce() {
          ctx.send('user-online', { id: ctx.connection.id });
        },
      }),
    }),
  });
}

describe('plugin() — scoped handler + manifest', () => {
  it('namespaces on / request / emits under __<id>::', () => {
    const { __primitives } = buildPresence()();
    expect(findPrimitive(__primitives, 'incoming', '__acme:presence::heartbeat')).toBeDefined();
    expect(findPrimitive(__primitives, 'request', '__acme:presence::who-is-here')).toBeDefined();
    expect(findPrimitive(__primitives, 'outgoing', '__acme:presence::user-online')).toBeDefined();
  });

  it('scopes a handler send so its event is prefixed at runtime', () => {
    const { __primitives } = buildPresence()();
    const incoming = findPrimitive(__primitives, 'incoming', '__acme:presence::heartbeat');
    const send = vi.fn();
    incoming.handler({ connection: { id: 'conn_1' }, send }, {});
    expect(send).toHaveBeenCalledWith('__acme:presence::user-online', { id: 'conn_1' });
  });

  it('registers its API factory through a pluginApi primitive', () => {
    const { __primitives } = buildPresence()();
    const apiPrimitive = findPrimitive(__primitives, 'pluginApi');
    const registerPluginApi = vi.fn();
    apiPrimitive.__setup({ registerPluginApi });
    expect(registerPluginApi).toHaveBeenCalledWith('acme:presence', expect.any(Function));
  });

  it('assembles into a host and compiles with the namespaced events', () => {
    const base = define({ capabilities: [buildPresence()()] });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [] }));
    expect(compiled.incoming.has('__acme:presence::heartbeat')).toBe(true);
    expect(compiled.requests.has('__acme:presence::who-is-here')).toBe(true);
  });

  it('does not collide with a host event of the same short name', () => {
    const base = define({ capabilities: [buildPresence()()] });
    const hostHeartbeat = base.on('heartbeat', { input: v.object({}), run() {} });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [hostHeartbeat] }));
    expect(compiled.incoming.has('heartbeat')).toBe(true);
    expect(compiled.incoming.has('__acme:presence::heartbeat')).toBe(true);
  });

  it('throws on an invalid plugin id', () => {
    const h = define({ scope: 'plugin' });
    expect(() => plugin('NotValid', { handler: h.assemble({ handlers: [] }) })).toThrow(
      /is invalid/,
    );
  });

  it('throws when the handler was not built with scoped define', () => {
    const h = define({});
    expect(() => plugin('acme:presence', { handler: h.assemble({ handlers: [] }) as any })).toThrow(
      /must be built with define\(\{ scope: 'plugin' \}\)/,
    );
  });

  it('reroutes a plugin connect hook into the plugin lifecycle registry', () => {
    const h = define({ scope: 'plugin' });
    h.onConnect(() => {});
    const { __primitives } = plugin('acme:presence', { handler: h.assemble({ handlers: [] }) })();
    const connectPrimitive = findPrimitive(__primitives, 'onConnect');
    const registerPluginLifecycle = vi.fn();
    connectPrimitive.__setup({ registerPluginLifecycle });
    expect(registerPluginLifecycle).toHaveBeenCalledWith(
      'connect',
      'acme:presence',
      expect.any(Function),
    );
  });

  it('rejects a user-declared event in the reserved __<id>::<name> space', () => {
    const base = define({});
    expect(() => base.on('__acme:presence::heartbeat', { run() {} })).toThrow(/reserved/);
  });

  it('rejects a plugin short event name ending with __ before namespacing', () => {
    const h = define({ scope: 'plugin' });
    expect(() => h.on('heartbeat__', { run() {} })).toThrow(/reserved '__' suffix/);
  });

  it('lets two plugins coexist without their namespaced surfaces colliding', () => {
    const a = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const aHandler = a.on('tick', { input: v.object({}), run() {} });
    const PluginA = plugin('acme:a', { handler: a.assemble({ handlers: [aHandler] }) });

    const b = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const bHandler = b.on('tick', { input: v.object({}), run() {} });
    const PluginB = plugin('acme:b', { handler: b.assemble({ handlers: [bHandler] }) });

    const base = define({ capabilities: [PluginA(), PluginB()] });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [] }));
    expect(compiled.incoming.has('__acme:a::tick')).toBe(true);
    expect(compiled.incoming.has('__acme:b::tick')).toBe(true);
  });

  it('routes a namespaced frame to the plugin handler through real dispatch', async () => {
    const base = define({ capabilities: [buildPresence()()] });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [] }));

    const send = vi.fn(() => true);
    const connection = { id: 'conn_1' } as any;
    const runtime = {
      compiled,
      connections: new Map([[connection.id, connection]]),
      channelMembers: new Map(),
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      errorHooks: [],
      buildConnectionContext: () => ({ connection: { id: connection.id }, send }),
      async handleRuntimeError() {},
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      generateId: () => 'id_1',
      toConnectionInfo() {
        throw new Error('unused');
      },
    };

    await dispatchIncoming(runtime as any, connection, {
      event: '__acme:presence::heartbeat',
      payload: {},
      wskit: { channelFamily: null },
    });

    expect(send).toHaveBeenCalledWith('__acme:presence::user-online', { id: 'conn_1' });
  });

  it('passes assemble() when every dependsOn prerequisite is listed', () => {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', {
      handler: h.assemble({ handlers: [tick] }),
      dependsOn: [rateLimit, keepalive],
    });
    const base = define({
      capabilities: [
        rateLimit(),
        keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 }),
        Dep(),
      ],
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });

  it('throws at assemble() when the same plugin id is listed twice, even with no api or handlers', () => {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const P = plugin('acme:dup', { handler: h.assemble({ handlers: [] }) });
    const base = define({ capabilities: [P(), P()] });
    expect(() => base.assemble({ handlers: [] })).toThrow(/listed more than once/);
  });

  it('throws at assemble() when two different plugins share an id', () => {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const First = plugin('acme:same', { handler: h.assemble({ handlers: [tick] }) });
    const Second = plugin('acme:same', { handler: h.assemble({ handlers: [tick] }) });
    const base = define({ capabilities: [First(), Second()] });
    expect(() => base.assemble({ handlers: [] })).toThrow(/listed more than once/);
  });

  it('throws at assemble() when a dependsOn prerequisite is missing', () => {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', {
      handler: h.assemble({ handlers: [tick] }),
      dependsOn: [rateLimit, keepalive],
    });
    const base = define({ capabilities: [rateLimit(), Dep()] });
    expect(() => base.assemble({ handlers: [] })).toThrow(/the host does not list/);
  });

  it('does not satisfy a host dependency with a different host capability', () => {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', {
      handler: h.assemble({ handlers: [tick] }),
      dependsOn: [rateLimit],
    });
    // dedup() is a host engine too, but a different one — it must NOT count as rateLimit().
    const base = define({ capabilities: [dedup(), Dep()] });
    expect(() => base.assemble({ handlers: [] })).toThrow(/the host does not list/);
  });

  it('satisfies a host dependency when that capability is listed', () => {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', {
      handler: h.assemble({ handlers: [tick] }),
      dependsOn: [rateLimit],
    });
    const base = define({ capabilities: [rateLimit(), Dep()] });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });

  it('throws the clean "does not list" error for a missing keepalive dependency without crashing', () => {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', {
      handler: h.assemble({ handlers: [tick] }),
      dependsOn: [keepalive],
    });
    const base = define({ capabilities: [Dep()] });
    expect(() => base.assemble({ handlers: [] })).toThrow(/the host does not list/);
  });

  it('satisfies a keepalive dependency when keepalive(...) is listed', () => {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', {
      handler: h.assemble({ handlers: [tick] }),
      dependsOn: [keepalive],
    });
    const base = define({
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 }), Dep()],
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });
});

describe('plugin() — hook ownership', () => {
  function buildHookPlugin() {
    const h = define({ scope: 'plugin', capabilities: [emits({ tick: t<{}>() }), intercepts()] });
    const beat = h.on('tick', { input: v.object({}), run() {} });
    h.intercept(() => {});
    h.onOutgoing(() => {});
    return plugin('acme:obs', { handler: h.assemble({ handlers: [beat] }) });
  }

  it('stamps a plugin intercept and outgoing hook with its owner', () => {
    const cap = buildHookPlugin()();
    const primitives = cap.__primitives as readonly any[];
    const intercept = primitives.find((p) => p.__wskit === 'intercept');
    const outgoing = primitives.find((p) => p.__wskit === 'outgoingHook');

    expect(intercept.__owner).toEqual({ kind: 'plugin', id: 'acme:obs' });
    expect(outgoing.__owner).toEqual({ kind: 'plugin', id: 'acme:obs' });
  });
});

describe('plugin() — auto-derived host dependencies', () => {
  it("auto-derives host sequence/dedup dependencies from a plugin's own replay primitive", () => {
    const h = define({ scope: 'plugin' });
    const cap = h.assemble({ handlers: [replay({}) as any] }) as {
      __hostDependencies?: readonly string[];
    };
    expect(cap.__hostDependencies).toEqual(expect.arrayContaining(['sequence', 'dedup']));
  });

  it('auto-derives host sequence/dedup dependencies from a plugin replay primitive nested in a plugin channel', () => {
    const h = define({ scope: 'plugin' });
    const cap = h.assemble({ handlers: [channel('room', replay({})) as any] }) as {
      __hostDependencies?: readonly string[];
    };
    expect(cap.__hostDependencies).toEqual(expect.arrayContaining(['sequence', 'dedup']));
  });

  it('throws at the host assemble() when an auto-derived host dependency is not listed', () => {
    const h = define({ scope: 'plugin' });
    const Presence = plugin('acme:presence', {
      handler: h.assemble({ handlers: [channel('room', replay({})) as any] }),
    });
    const base = define({ capabilities: [Presence()] });
    expect(() => base.assemble({ handlers: [] })).toThrow(/the host does not list/);
  });

  it('passes the host assemble() once every auto-derived host dependency is listed', () => {
    const h = define({ scope: 'plugin' });
    const Presence = plugin('acme:presence', {
      handler: h.assemble({ handlers: [channel('room', replay({})) as any] }),
    });
    const base = define({
      capabilities: [dedup(), sequence({ persist: true }), Presence()],
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });
});

describe("plugin() — a plugin's own capability satisfies its own nested primitive's requirement", () => {
  /** A plugin that owns its channel — lists channels() itself, puts inbox() on that channel. */
  function buildFeed() {
    const h = define({ scope: 'plugin', capabilities: [channels()] });
    const room = h.channel('room', { capabilities: [inbox()] });
    return plugin('acme:feed', { handler: h.assemble({ handlers: [room] }) });
  }

  it('assembles cleanly on a host that does not list channels() — the plugin owns it', () => {
    const Feed = buildFeed();
    const base = define({
      capabilities: [sequence({ persist: true }), dedup(), Feed()],
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });

  it('still requires the host to provide sequence(), naming the plugin', () => {
    const Feed = buildFeed();
    const base = define({ capabilities: [dedup(), Feed()] });
    expect(() => base.assemble({ handlers: [] })).toThrow(
      "[wskit] plugin('acme:feed') needs the sequence() capability the host does not list.",
    );
  });

  it('still requires the host to provide dedup(), naming the plugin', () => {
    const Feed = buildFeed();
    const base = define({ capabilities: [sequence({ persist: true }), Feed()] });
    expect(() => base.assemble({ handlers: [] })).toThrow(
      "[wskit] plugin('acme:feed') needs the dedup() capability the host does not list.",
    );
  });
});

describe("plugin() — a plugin's dynamic channel family stays subscribable and isolated", () => {
  function createTestConnection(id: string) {
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
      quality: 'good' as const,
    };
  }

  /** A minimal ChannelRuntime driven off the real compiled channel families of an assembled define. */
  function createChannelTestRuntime(compiled: {
    channels: Map<any, any>;
    channelFamilies: Map<any, any>;
  }) {
    const connections = new Map<string, ReturnType<typeof createTestConnection>>();
    return {
      connections,
      runtime: {
        compiled,
        connections,
        channelMembers: new Map(),
        checkHooks: new Map(),
        revalidateHooks: new Map(),
        commitHooks: new Map(),
        subscribeHooks: new Map(),
        unsubscribeHooks: new Map(),
        sessionEndHooks: new Map(),
        toConnectionInfo() {
          throw new Error('unused');
        },
        buildConnectionContext(connection: ReturnType<typeof createTestConnection>) {
          return { id: connection.id };
        },
        persistAttachment() {},
        sendProtocolMessage() {},
        broadcastToChannel() {},
        async handleValidationError() {},
        async handleRuntimeError() {},
        isChannelDurable: () => false,
        persistMembership: () => {},
        deleteDurableMembership: () => {},
        hasDurableMembership: () => true,
      },
    };
  }

  function buildThreadFeed() {
    const h = define({ scope: 'plugin', capabilities: [channels()] });
    const thread = h.channel(['thread', 'thread:{id}'], {});
    return plugin('acme:feed', { handler: h.assemble({ handlers: [thread] }) });
  }

  it('subscribes to a plugin-owned dynamic family by its namespaced family key and bare concrete name, capturing {id}', async () => {
    const Feed = buildThreadFeed();
    const base = define({
      capabilities: [sequence({ persist: true }), dedup(), Feed()],
    });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [] }));
    const { runtime, connections } = createChannelTestRuntime(compiled);

    const connection = createTestConnection('conn_1');
    connections.set(connection.id, connection);

    const channelFamily = '__acme:feed::thread';
    const channelName = 'thread:t1';

    await subscribeConnection(runtime as any, connection as any, {
      channelName,
      channelFamily,
      data: undefined,
    });

    expect(
      connection.channelMemberships.has(createChannelMembershipKey(channelName, channelFamily)),
    ).toBe(true);

    const resolved = compiled.channelFamilies.get(channelFamily);
    const extra = buildChannelFamilyExtra(
      connection as any,
      { channel: resolved, channelName, channelFamily },
      {
        broadcastToChannel: vi.fn(),
        getChannelMembers: vi.fn(),
        kickChannelMembers: vi.fn(),
        sendThroughPipeline: vi.fn(),
        sendToChannelRecipient: vi.fn(),
        subscribeConnectionAsServer: vi.fn(),
      } as any,
    );
    expect(extra.channel?.params).toEqual({ id: 't1' });
  });

  it("keeps a plugin's dynamic family isolated from a host family sharing the same bare key/template", async () => {
    const Feed = buildThreadFeed();
    const base = define({
      capabilities: [sequence({ persist: true }), dedup(), channels(), Feed()],
    });
    const hostThread = base.channel(['thread', 'thread:{id}'], {});
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [hostThread] }));
    const { runtime, connections } = createChannelTestRuntime(compiled);

    const hostSubscriber = createTestConnection('host_conn');
    const pluginSubscriber = createTestConnection('plugin_conn');
    connections.set(hostSubscriber.id, hostSubscriber);
    connections.set(pluginSubscriber.id, pluginSubscriber);

    // Both subscribe by the same bare concrete name — isolation must come
    // entirely from the namespaced family key, since lookup resolves the
    // family first.
    await subscribeConnection(runtime as any, hostSubscriber as any, {
      channelName: 'thread:t1',
      channelFamily: 'thread',
      data: undefined,
    });
    await subscribeConnection(runtime as any, pluginSubscriber as any, {
      channelName: 'thread:t1',
      channelFamily: '__acme:feed::thread',
      data: undefined,
    });

    const hostKey = createChannelMembershipKey('thread:t1', 'thread');
    const pluginKey = createChannelMembershipKey('thread:t1', '__acme:feed::thread');
    expect(hostKey).not.toBe(pluginKey);
    expect(hostSubscriber.channelMemberships.has(hostKey)).toBe(true);
    expect(hostSubscriber.channelMemberships.has(pluginKey)).toBe(false);
    expect(pluginSubscriber.channelMemberships.has(pluginKey)).toBe(true);
    expect(pluginSubscriber.channelMemberships.has(hostKey)).toBe(false);

    const memberList = (runtime as unknown as { channelMembers: Map<string, Set<{ id: string }>> })
      .channelMembers;
    expect([...(memberList.get(hostKey) ?? [])].map((m) => m.id)).toEqual([hostSubscriber.id]);
    expect([...(memberList.get(pluginKey) ?? [])].map((m) => m.id)).toEqual([pluginSubscriber.id]);
  });
});
