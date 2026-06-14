/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { dispatchIncoming } from '~/_engine/runtime/messages.ts';
import { emits } from '~/emits/emits.ts';
import { requests } from '~/request/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { plugin } from './plugin.ts';

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
    const { __primitives } = buildPresence();
    expect(findPrimitive(__primitives, 'incoming', '__acme:presence::heartbeat')).toBeDefined();
    expect(findPrimitive(__primitives, 'request', '__acme:presence::who-is-here')).toBeDefined();
    expect(findPrimitive(__primitives, 'outgoing', '__acme:presence::user-online')).toBeDefined();
  });

  it('scopes a handler send so its event is prefixed at runtime', () => {
    const { __primitives } = buildPresence();
    const incoming = findPrimitive(__primitives, 'incoming', '__acme:presence::heartbeat');
    const send = vi.fn();
    incoming.handler({ id: 'conn_1', send }, {});
    expect(send).toHaveBeenCalledWith('__acme:presence::user-online', { id: 'conn_1' });
  });

  it('registers its API factory through a pluginApi primitive', () => {
    const { __primitives } = buildPresence();
    const apiPrimitive = findPrimitive(__primitives, 'pluginApi');
    const registerPluginApi = vi.fn();
    apiPrimitive.__setup({ registerPluginApi });
    expect(registerPluginApi).toHaveBeenCalledWith('acme:presence', expect.any(Function));
  });

  it('assembles into a host and compiles with the namespaced events', () => {
    const base = define({ env: t<Env>(), capabilities: [buildPresence()] });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.incoming.has('__acme:presence::heartbeat')).toBe(true);
    expect(compiled.requests.has('__acme:presence::who-is-here')).toBe(true);
  });

  it('does not collide with a host event of the same short name', () => {
    const base = define({ env: t<Env>(), capabilities: [buildPresence()] });
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

  it('throws when a plugin contributes an unsupported primitive', () => {
    const h = define({ scoped: true });
    h.connect(() => {});
    expect(() => plugin('acme:presence', { handler: h.assemble() })).toThrow(
      /uses 'onConnect', which a plugin cannot contribute yet/,
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

    const base = define({ env: t<Env>(), capabilities: [PluginA, PluginB] });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.incoming.has('__acme:a::tick')).toBe(true);
    expect(compiled.incoming.has('__acme:b::tick')).toBe(true);
  });

  it('routes a namespaced frame to the plugin handler through real dispatch', async () => {
    const base = define({ env: t<Env>(), capabilities: [buildPresence()] });
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
      pluginRuntimes: [],
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
      wskit: { channelScope: null },
    });

    expect(send).toHaveBeenCalledWith('__acme:presence::user-online', { id: 'conn_1' });
  });
});
