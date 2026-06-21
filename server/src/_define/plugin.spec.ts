/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { dispatchIncoming } from '~/_engine/runtime/messages.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { persistence } from '~/persistence/capability.ts';
import { requests } from '~/request/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { observeHost, plugin } from './plugin.ts';

interface Env {
  SECRET: string;
}

function findPrimitive(primitives: readonly any[], wskit: string, event?: string): any {
  const found = primitives.find((p) => p.__wskit === wskit && (event ? p.event === event : true));
  if (!found) throw new Error(`no ${wskit} primitive${event ? ` for ${event}` : ''}`);
  return found;
}

/** A small presence-style plugin authored as a scoped handler. */
function buildPresence() {
  const h = define({
    scoped: true,
    capabilities: [emits({ 'user-online': t<{ id: string }>() }), requests()],
  });
  const heartbeat = h.on('heartbeat', {
    input: v.object({}),
    run(ctx) {
      ctx.send('user-online', { id: ctx.id });
    },
  });
  const whoIsHere = h.request('who-is-here', {
    input: v.object({}),
    run() {
      return { users: [] as string[] };
    },
  });
  return plugin('acme:presence', {
    handler: h.assemble(heartbeat, whoIsHere),
    api: (ctx) => ({
      announce() {
        ctx.send('user-online', { id: ctx.id });
      },
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
    incoming.handler({ id: 'conn_1', send }, {});
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
    const base = define({ env: t<Env>(), capabilities: [buildPresence()()] });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.incoming.has('__acme:presence::heartbeat')).toBe(true);
    expect(compiled.requests.has('__acme:presence::who-is-here')).toBe(true);
  });

  it('does not collide with a host event of the same short name', () => {
    const base = define({ env: t<Env>(), capabilities: [buildPresence()()] });
    const hostHeartbeat = base.on('heartbeat', { input: v.object({}), run() {} });
    const compiled = compileHandlerDefinition(base.assemble(hostHeartbeat));
    expect(compiled.incoming.has('heartbeat')).toBe(true);
    expect(compiled.incoming.has('__acme:presence::heartbeat')).toBe(true);
  });

  it('throws on an invalid plugin id', () => {
    const h = define({ scoped: true });
    expect(() => plugin('NotValid', { handler: h.assemble() })).toThrow(/is invalid/);
  });

  it('throws when the handler was not built with scoped define', () => {
    const h = define({ env: t<Env>() });
    expect(() => plugin('acme:presence', { handler: h.assemble() as any })).toThrow(
      /must be built with define\(\{ scoped: true \}\)/,
    );
  });

  it('reroutes a plugin connect hook into the plugin lifecycle registry', () => {
    const h = define({ scoped: true });
    h.connect(() => {});
    const { __primitives } = plugin('acme:presence', { handler: h.assemble() })();
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
    const base = define({ env: t<Env>() });
    const sneaky = base.on('__acme:presence::heartbeat', { run() {} });
    expect(() => compileHandlerDefinition(base.assemble(sneaky))).toThrow(/reserved/);
  });

  it('lets two plugins coexist without their namespaced surfaces colliding', () => {
    const a = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const aHandler = a.on('tick', { input: v.object({}), run() {} });
    const PluginA = plugin('acme:a', { handler: a.assemble(aHandler) });

    const b = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const bHandler = b.on('tick', { input: v.object({}), run() {} });
    const PluginB = plugin('acme:b', { handler: b.assemble(bHandler) });

    const base = define({ env: t<Env>(), capabilities: [PluginA(), PluginB()] });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.incoming.has('__acme:a::tick')).toBe(true);
    expect(compiled.incoming.has('__acme:b::tick')).toBe(true);
  });

  it('routes a namespaced frame to the plugin handler through real dispatch', async () => {
    const base = define({ env: t<Env>(), capabilities: [buildPresence()()] });
    const compiled = compileHandlerDefinition(base.assemble());

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
      buildConnectionContext: () => ({ id: connection.id, send }),
      async handleRuntimeError() {},
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      waitUntil() {},
      generateId: () => 'id_1',
      requireTimers: () => ({ setTimeout: () => undefined, clearTimeout() {} }),
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
    const h = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', {
      handler: h.assemble(tick),
      dependsOn: [persistence, keepalive],
    });
    const base = define({
      env: t<Env>(),
      capabilities: [
        persistence(),
        keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 }),
        Dep(),
      ],
    });
    expect(() => base.assemble()).not.toThrow();
  });

  it('throws at assemble() when a dependsOn prerequisite is missing', () => {
    const h = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', {
      handler: h.assemble(tick),
      dependsOn: [persistence, keepalive],
    });
    const base = define({ env: t<Env>(), capabilities: [persistence(), Dep()] });
    expect(() => base.assemble()).toThrow(/the host does not list/);
  });

  it('does not satisfy a host dependency with a different host capability', () => {
    const h = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', { handler: h.assemble(tick), dependsOn: [persistence] });
    // dedup() is a host engine too, but a different one — it must NOT count as persistence().
    const base = define({ env: t<Env>(), capabilities: [dedup(), Dep()] });
    expect(() => base.assemble()).toThrow(/the host does not list/);
  });

  it('satisfies a host dependency when that capability is listed', () => {
    const h = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', { handler: h.assemble(tick), dependsOn: [persistence] });
    const base = define({ env: t<Env>(), capabilities: [persistence(), Dep()] });
    expect(() => base.assemble()).not.toThrow();
  });

  it("auto-derives a host persistence dependency from a plugin's own durable stream", () => {
    const h = define({ scoped: true, capabilities: [resumableStream()] });
    const feed = h.resumableStream('feed', {
      input: v.object({}),
      chunk: t<{ n: number }>(),
      async *run() {
        yield { n: 1 };
      },
    });
    // No dependsOn — the persistence requirement is inferred from the durable
    // stream the plugin owns.
    const Dep = plugin('acme:dep', { handler: h.assemble(feed) });
    const without = define({ env: t<Env>(), capabilities: [Dep()] });
    expect(() => without.assemble()).toThrow(/the host does not list/);
    const withPersistence = define({
      env: t<Env>(),
      capabilities: [persistence(), resumableStream(), Dep()],
    });
    expect(() => withPersistence.assemble()).not.toThrow();
  });

  it('auto-derives persistence from a plugin durable stream nested in a plugin channel', () => {
    const h = define({ scoped: true, capabilities: [channels(), recordedStream()] });
    const rooms = h.channel('rooms', {});
    const feed = rooms.recordedStream('paginate', { async *run() {} } as any);
    const Dep = plugin('acme:roomfeed', { handler: h.assemble(feed) });
    const without = define({ env: t<Env>(), capabilities: [channels(), Dep()] });
    expect(() => without.assemble()).toThrow(/the host does not list/);
    const withPersistence = define({
      env: t<Env>(),
      capabilities: [persistence(), channels(), recordedStream(), Dep()],
    });
    expect(() => withPersistence.assemble()).not.toThrow();
  });

  it('auto-derives persistence from a plugin persistent tag group', () => {
    const h = define({
      scoped: true,
      capabilities: [tags((_e, p) => [p('favorite', t<string>())])],
    });
    const Dep = plugin('acme:tagger', { handler: h.assemble() });
    const without = define({ env: t<Env>(), capabilities: [Dep()] });
    expect(() => without.assemble()).toThrow(/the host does not list/);
    const withPersistence = define({ env: t<Env>(), capabilities: [persistence(), Dep()] });
    expect(() => withPersistence.assemble()).not.toThrow();
  });

  it('throws the clean "does not list" error for a missing keepalive dependency without crashing', () => {
    const h = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', { handler: h.assemble(tick), dependsOn: [keepalive] });
    const base = define({ env: t<Env>(), capabilities: [Dep()] });
    expect(() => base.assemble()).toThrow(/the host does not list/);
  });

  it('satisfies a keepalive dependency when keepalive(...) is listed', () => {
    const h = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const tick = h.on('tick', { input: v.object({}), run() {} });
    const Dep = plugin('acme:dep', { handler: h.assemble(tick), dependsOn: [keepalive] });
    const base = define({
      env: t<Env>(),
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 }), Dep()],
    });
    expect(() => base.assemble()).not.toThrow();
  });
});

describe('plugin() — host-traffic observation', () => {
  /** A plugin with one intercept and one outgoing hook; `observes` opts into host traffic. */
  function buildObserver(observes: boolean) {
    const h = define({ scoped: true, capabilities: [emits({ tick: t<{}>() })] });
    const beat = h.on('tick', { input: v.object({}), run() {} });
    h.intercept(() => {});
    h.outgoing(() => {});
    return plugin('acme:obs', {
      handler: h.assemble(beat),
      observesHostTraffic: observes,
    });
  }

  it('stamps a plugin intercept/outgoing hook with its owner and observesHost flag', () => {
    const cap = buildObserver(true)();
    const primitives = cap.__primitives as readonly any[];
    const intercept = primitives.find((p) => p.__wskit === 'intercept');
    const outgoing = primitives.find((p) => p.__wskit === 'outgoingHook');

    expect(intercept.__owner).toEqual({ kind: 'plugin', id: 'acme:obs' });
    expect(intercept.__observesHost).toBe(true);
    expect(outgoing.__owner).toEqual({ kind: 'plugin', id: 'acme:obs' });
    expect(outgoing.__observesHost).toBe(true);
  });

  it('defaults a plugin hook to observesHost = false (own-frame only)', () => {
    const cap = buildObserver(false)();
    const intercept = (cap.__primitives as readonly any[]).find((p) => p.__wskit === 'intercept');
    expect(intercept.__observesHost).toBe(false);
  });

  it('assemble() throws if an observing plugin is listed without observeHost(...)', () => {
    const Obs = buildObserver(true);
    const base = define({ env: t<Env>(), capabilities: [Obs()] });
    expect(() => base.assemble()).toThrowError(/observeHost/);
  });

  it('assemble() passes and warns once when wrapped in observeHost(...)', () => {
    const Obs = buildObserver(true);
    const warn = vi.fn();
    // The audit log goes to console.warn at assemble; spy on it.
    const spy = vi.spyOn(console, 'warn').mockImplementation(warn);
    try {
      const base = define({ env: t<Env>(), capabilities: [observeHost(Obs())] });
      expect(() => base.assemble()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('acme:obs');
    expect(warn.mock.calls[0]![0]).toContain('host-traffic observation');
  });

  it('observeHost(...) marks the grant on the capability', () => {
    const granted = observeHost(buildObserver(true)());
    expect((granted as any).__hostObservationGranted).toBe(true);
  });

  it('a non-observing plugin needs no grant and never warns', () => {
    const Plain = buildObserver(false);
    const warn = vi.fn();
    const spy = vi.spyOn(console, 'warn').mockImplementation(warn);
    try {
      const base = define({ env: t<Env>(), capabilities: [Plain()] });
      expect(() => base.assemble()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
