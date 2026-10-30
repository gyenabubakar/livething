import { t } from '~/_api/definitions.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import { dispatchIncoming } from '~/_engine/runtime/messages.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import { clientRequests } from '~/request/client-requests.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { plugin } from './plugins.ts';
import { server } from './server.ts';
import type { AnyCapability } from './capability.ts';

type DispatchRuntime = Parameters<typeof dispatchIncoming>[0];
type DispatchConnection = Parameters<typeof dispatchIncoming>[1];

const NotFound = error('not-found', v.object({ id: v.string() }));

function makeBase() {
  return server({
    upgrade(request) {
      const username = new URL(request.url).searchParams.get('username') ?? 'anon';
      return { userId: username, meta: { username } };
    },
    capabilities: [emits({ welcome: t<{ username: string }>() }), errors([NotFound])],
  });
}

describe('server() send/receive core', () => {
  it('rejects a capability listed more than once', () => {
    const capabilities: AnyCapability[] = [channels(), channels()];
    expect(() => server({ capabilities })).toThrow(/channels\(\) is listed more than once/);
  });

  it('rejects a duplicate capability in a plugin-scoped definition', () => {
    const capabilities: AnyCapability[] = [emits({ first: t<{}>() }), emits({ second: t<{}>() })];
    expect(() => server({ scope: 'plugin', capabilities })).toThrow(
      /emits\(\) is listed more than once/,
    );
  });

  it('assembles handlers, capabilities, and the upgrade hook into a bootable server', () => {
    const base = server({
      upgrade(request) {
        const username = new URL(request.url).searchParams.get('username') ?? 'anon';
        return { userId: username, meta: { username } };
      },
      capabilities: [emits({ welcome: t<{ username: string }>() }), errors([NotFound])],
      onConnect(ctx) {
        ctx.send('welcome', { username: ctx.meta.username });
      },
    });

    const handlePing = base.on('echo', {
      input: v.object({ text: v.string() }),
      run(ctx, input) {
        ctx.send('welcome', { username: input.text });
      },
    });

    const definition = base.assemble({ handlers: [handlePing] });
    const compiled = compileServerDefinition(definition);

    expect(compiled.incoming.has('echo')).toBe(true);
    expect(compiled.outgoing.has('welcome')).toBe(true);
    expect(definition.primitives.some((p) => p.__livething === 'onUpgrade')).toBe(true);
    expect(definition.primitives.some((p) => p.__livething === 'onConnect')).toBe(true);
    expect(definition.primitives.some((p) => p.__livething === 'errors')).toBe(true);
  });

  it('accepts a handler with no input schema, typing the payload as unknown', () => {
    const base = makeBase();
    const handleEcho = base.on('echo-anything', {
      run(ctx, input) {
        ctx.send('welcome', { username: String(input) });
      },
    });
    const compiled = compileServerDefinition(base.assemble({ handlers: [handleEcho] }));
    expect(compiled.incoming.has('echo-anything')).toBe(true);
  });

  it('uses ordered work for on handlers and interleaved work for requests by default', () => {
    const base = server({ capabilities: [clientRequests()] });
    const incoming = base.on('incoming', { run() {} });
    const request = base.request('request', { run() {} });
    const compiled = compileServerDefinition(base.assemble({ handlers: [incoming, request] }));

    expect(compiled.incoming.get('incoming')?.allowInterleaving).toBe(false);
    expect(compiled.requests.get('request')?.allowInterleaving).toBe(true);
  });

  it('only enables handlers passed to assemble at every scope', async () => {
    const top = server({});
    const runTop = vi.fn();
    const runTopHidden = vi.fn();
    const topActive = top.on('top-active', { run: runTop });
    top.on('top-hidden', { run: runTopHidden });

    const topCompiled = compileServerDefinition(top.assemble({ handlers: [topActive] }));
    expect(topCompiled.incoming.has('top-hidden')).toBe(false);

    const scoped = server({ scope: 'plugin' });
    const runPlugin = vi.fn();
    const runPluginHidden = vi.fn();
    const pluginActive = scoped.on('plugin-active', { run: runPlugin });
    scoped.on('plugin-hidden', { run: runPluginHidden });

    const HiddenPlugin = plugin('acme:hidden', {
      definition: scoped.assemble({ handlers: [pluginActive] }),
    });
    const host = server({ capabilities: [HiddenPlugin()] });
    const pluginCompiled = compileServerDefinition(host.assemble({ handlers: [] }));
    expect(pluginCompiled.incoming.has('__acme:hidden::plugin-hidden')).toBe(false);

    const channelBase = server({ capabilities: [channels()] });
    const room = channelBase.channel('room', {});
    const runChannel = vi.fn();
    const runChannelHidden = vi.fn();
    const active = room.on('active', { run: runChannel });

    room.on('channel-hidden', { run: runChannelHidden });
    const compiled = compileServerDefinition(channelBase.assemble({ handlers: [active] }));

    expect(compiled.channels.get('room')?.incoming.has('active')).toBe(true);
    expect(compiled.channels.get('room')?.incoming.has('channel-hidden')).toBe(false);

    const channelWithoutHandlers = compileServerDefinition(
      channelBase.assemble({ handlers: [room] }),
    );
    expect(channelWithoutHandlers.channels.get('room')?.incoming.has('active')).toBe(false);

    const connection = {
      id: 'conn_1',
      channelMemberships: new Set([JSON.stringify([null, 'room'])]),
    } as unknown as DispatchConnection;
    function createRuntime(definition: typeof compiled): DispatchRuntime {
      return {
        compiled: definition,
        connections: new Map([[connection.id, connection]]),
        channelMembers: new Map(),
        activeStreams: new Map(),
        protocolHandlers: new Map(),
        incomingHooks: [],
        errorHooks: [],
        buildConnectionContext: () => ({ connection: { id: connection.id } }),
        async handleRuntimeError() {},
        async handleSubscribe() {},
        async handleUnsubscribe() {},
        sendProtocolMessage() {},
        sendReplay() {},
        persistAttachment() {},
        generateId: () => 'id_1',
        toConnectionInfo() {
          throw new Error('unused');
        },
      } as unknown as DispatchRuntime;
    }

    await dispatchIncoming(createRuntime(topCompiled), connection, {
      event: 'top-active',
      payload: {},
      livething: undefined,
    });
    await dispatchIncoming(createRuntime(topCompiled), connection, {
      event: 'top-hidden',
      payload: {},
      livething: undefined,
    });
    expect(runTop).toHaveBeenCalledOnce();
    expect(runTopHidden).not.toHaveBeenCalled();

    await dispatchIncoming(createRuntime(pluginCompiled), connection, {
      event: '__acme:hidden::plugin-active',
      payload: {},
      livething: { channelFamily: null },
    });
    await dispatchIncoming(createRuntime(pluginCompiled), connection, {
      event: '__acme:hidden::plugin-hidden',
      payload: {},
      livething: { channelFamily: null },
    });
    expect(runPlugin).toHaveBeenCalledOnce();
    expect(runPluginHidden).not.toHaveBeenCalled();

    await dispatchIncoming(createRuntime(compiled), connection, {
      event: 'active',
      payload: {},
      livething: { channel: 'room', channelFamily: null },
    });
    await dispatchIncoming(createRuntime(compiled), connection, {
      event: 'channel-hidden',
      payload: {},
      livething: { channel: 'room', channelFamily: null },
    });
    expect(runChannel).toHaveBeenCalledOnce();
    expect(runChannelHidden).not.toHaveBeenCalled();
  });

  it('registers a single intercept', () => {
    const base = server({
      intercept(_ctx, frame) {
        if (frame.event === 'blocked') throw new Error('blocked');
      },
    });
    const compiled = compileServerDefinition(base.assemble({ handlers: [] }));
    expect(compiled.intercepts).toHaveLength(1);
  });

  it('adds every event declared by one emits capability to the outgoing surface', () => {
    const base = server({
      capabilities: [
        emits({
          welcome: t<{ username: string }>(),
          goodbye: t<{ username: string }>(),
        }),
      ],
    });
    const compiled = compileServerDefinition(base.assemble({ handlers: [] }));
    expect(compiled.outgoing.has('welcome')).toBe(true);
    expect(compiled.outgoing.has('goodbye')).toBe(true);
  });

  it('wires hibernation into a primitive when enabled', () => {
    const base = server({ hibernation: true });
    const definition = base.assemble({ handlers: [] });
    expect(definition.primitives.some((p) => p.__livething === 'hibernation')).toBe(true);
  });

  it('omits hibernation when not enabled', () => {
    for (const base of [server({}), server({ hibernation: false })]) {
      const definition = base.assemble({ handlers: [] });
      expect(definition.primitives.some((p) => p.__livething === 'hibernation')).toBe(false);
    }
  });

  it('throws when the same event is bound by two handlers passed to assemble', () => {
    const base = makeBase();
    const first = base.on('echo', { input: v.object({ text: v.string() }), run() {} });
    const second = base.on('echo', { input: v.object({ text: v.string() }), run() {} });
    // @ts-expect-error: the same event twice at the top level is a compile error
    expect(() => base.assemble({ handlers: [first, second] })).toThrow(
      /Duplicate incoming handler for 'echo'/,
    );
  });

  it('throws when a capability is passed to assemble instead of being listed', () => {
    const base = makeBase();
    const cap = emits({ extra: t<{ ok: boolean }>() });
    expect(() => base.assemble({ handlers: [cap as never] })).toThrow(
      /capability was passed to assemble/,
    );
  });

  it('throws when one event name is bound by both an on and a request handler', () => {
    const base = server({ capabilities: [clientRequests()] });
    const asEvent = base.on('shared', { input: v.object({}), run() {} });
    const asRequest = base.request('shared', { input: v.object({}), run() {} });
    // @ts-expect-error: the same event twice at the top level is a compile error
    expect(() => base.assemble({ handlers: [asEvent, asRequest] })).toThrow(
      /Event name 'shared' is bound by both a incoming handler and a request handler/,
    );
  });
});

describe('server({ users }) maxConnections validation', () => {
  it('rejects maxConnections: 0', () => {
    const base = server({
      users: { maxConnections: 0, onExceed: 'replace' },
    });
    expect(() => base.assemble({ handlers: [] })).toThrow(/maxConnections/);
  });

  it('rejects a negative maxConnections', () => {
    const base = server({
      users: { maxConnections: -1, onExceed: 'reject' },
    });
    expect(() => base.assemble({ handlers: [] })).toThrow(/maxConnections/);
  });

  it('rejects a non-integer maxConnections', () => {
    const base = server({
      users: { maxConnections: 2.5, onExceed: 'replace' },
    });
    expect(() => base.assemble({ handlers: [] })).toThrow(/maxConnections/);
  });

  it('accepts a positive integer maxConnections', () => {
    const base = server({
      users: { maxConnections: 3, onExceed: 'replace' },
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });

  it('accepts users config with maxConnections omitted', () => {
    const base = server({
      users: { onExceed: 'reject' },
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });
});
