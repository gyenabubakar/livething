import { t } from '~/_api/definitions.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { dispatchIncoming } from '~/_engine/runtime/messages.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import { intercepts } from '~/intercept/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { translator } from '~/translation/translator.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { define } from './define.ts';
import { plugin } from './plugins.ts';

type DispatchRuntime = Parameters<typeof dispatchIncoming>[0];
type DispatchConnection = Parameters<typeof dispatchIncoming>[1];

const NotFound = error('not-found', v.object({ id: v.string() }));

function makeBase() {
  return define({
    upgrade(request) {
      const username = new URL(request.url).searchParams.get('username') ?? 'anon';
      return { userId: username, meta: { username } };
    },
    capabilities: [emits({ welcome: t<{ username: string }>() }), errors([NotFound]), intercepts()],
  });
}

describe('define() send/receive core', () => {
  it('assembles handlers, capabilities, and the upgrade hook into a bootable server', () => {
    const base = makeBase();

    const handlePing = base.on('echo', {
      input: v.object({ text: v.string() }),
      run(ctx, input) {
        ctx.send('welcome', { username: input.text });
      },
    });

    base.onConnect((ctx) => {
      ctx.send('welcome', { username: ctx.meta.username });
    });

    const handler = base.assemble({ handlers: [handlePing] });
    const compiled = compileHandlerDefinition(handler);

    expect(compiled.incoming.has('echo')).toBe(true);
    expect(compiled.outgoing.has('welcome')).toBe(true);
    expect(handler.primitives.some((p) => p.__wskit === 'onUpgrade')).toBe(true);
    expect(handler.primitives.some((p) => p.__wskit === 'onConnect')).toBe(true);
    expect(handler.primitives.some((p) => p.__wskit === 'errors')).toBe(true);
  });

  it('accepts a handler with no input schema, typing the payload as unknown', () => {
    const base = makeBase();
    const handleEcho = base.on('echo-anything', {
      run(ctx, input) {
        ctx.send('welcome', { username: String(input) });
      },
    });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [handleEcho] }));
    expect(compiled.incoming.has('echo-anything')).toBe(true);
  });

  it('uses ordered work for on handlers and interleaved work for requests by default', () => {
    const base = define({ capabilities: [clientRequests()] });
    const incoming = base.on('incoming', { run() {} });
    const request = base.request('request', { run() {} });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [incoming, request] }));

    expect(compiled.incoming.get('incoming')?.allowInterleaving).toBe(false);
    expect(compiled.requests.get('request')?.allowInterleaving).toBe(true);
  });

  it('only enables handlers passed to assemble at every scope', async () => {
    const top = define({});
    const runTop = vi.fn();
    const runTopHidden = vi.fn();
    const topActive = top.on('top-active', { run: runTop });
    top.on('top-hidden', { run: runTopHidden });

    const topCompiled = compileHandlerDefinition(top.assemble({ handlers: [topActive] }));
    expect(topCompiled.incoming.has('top-hidden')).toBe(false);

    const scoped = define({ scope: 'plugin' });
    const runPlugin = vi.fn();
    const runPluginHidden = vi.fn();
    const pluginActive = scoped.on('plugin-active', { run: runPlugin });
    scoped.on('plugin-hidden', { run: runPluginHidden });

    const HiddenPlugin = plugin('acme:hidden', {
      handler: scoped.assemble({ handlers: [pluginActive] }),
    });
    const host = define({ capabilities: [HiddenPlugin()] });
    const pluginCompiled = compileHandlerDefinition(host.assemble({ handlers: [] }));
    expect(pluginCompiled.incoming.has('__acme:hidden::plugin-hidden')).toBe(false);

    const channelBase = define({ capabilities: [channels()] });
    const room = channelBase.channel('room', {});
    const runChannel = vi.fn();
    const runChannelHidden = vi.fn();
    const active = room.on('active', { run: runChannel });

    room.on('channel-hidden', { run: runChannelHidden });
    const compiled = compileHandlerDefinition(channelBase.assemble({ handlers: [active] }));

    expect(compiled.channels.get('room')?.incoming.has('active')).toBe(true);
    expect(compiled.channels.get('room')?.incoming.has('channel-hidden')).toBe(false);

    const channelWithoutHandlers = compileHandlerDefinition(
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
      } as unknown as DispatchRuntime;
    }

    await dispatchIncoming(createRuntime(topCompiled), connection, {
      event: 'top-active',
      payload: {},
      wskit: undefined,
    });
    await dispatchIncoming(createRuntime(topCompiled), connection, {
      event: 'top-hidden',
      payload: {},
      wskit: undefined,
    });
    expect(runTop).toHaveBeenCalledOnce();
    expect(runTopHidden).not.toHaveBeenCalled();

    await dispatchIncoming(createRuntime(pluginCompiled), connection, {
      event: '__acme:hidden::plugin-active',
      payload: {},
      wskit: { channelFamily: null },
    });
    await dispatchIncoming(createRuntime(pluginCompiled), connection, {
      event: '__acme:hidden::plugin-hidden',
      payload: {},
      wskit: { channelFamily: null },
    });
    expect(runPlugin).toHaveBeenCalledOnce();
    expect(runPluginHidden).not.toHaveBeenCalled();

    await dispatchIncoming(createRuntime(compiled), connection, {
      event: 'active',
      payload: {},
      wskit: { channel: 'room', channelFamily: null },
    });
    await dispatchIncoming(createRuntime(compiled), connection, {
      event: 'channel-hidden',
      payload: {},
      wskit: { channel: 'room', channelFamily: null },
    });
    expect(runChannel).toHaveBeenCalledOnce();
    expect(runChannelHidden).not.toHaveBeenCalled();
  });

  it('registers a single intercept', () => {
    const base = makeBase();
    base.intercept((_ctx, frame) => {
      if (frame.event === 'blocked') throw new Error('blocked');
    });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [] }));
    expect(compiled.intercepts).toHaveLength(1);
  });

  it('merges multiple emits capabilities into the outgoing surface', () => {
    const base = define({
      capabilities: [
        emits({ welcome: t<{ username: string }>() }),
        emits({ goodbye: t<{ username: string }>() }),
      ],
    });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [] }));
    expect(compiled.outgoing.has('welcome')).toBe(true);
    expect(compiled.outgoing.has('goodbye')).toBe(true);
  });

  it('wires hibernation into a primitive and the feature set when enabled', () => {
    const base = define({ hibernation: { enabled: true } });
    const handler = base.assemble({ handlers: [] });
    expect(handler.primitives.some((p) => p.__wskit === 'hibernation')).toBe(true);
    expect(handler.__features?.has('hibernation')).toBe(true);
  });

  it('omits hibernation when not enabled', () => {
    const base = define({});
    const handler = base.assemble({ handlers: [] });
    expect(handler.primitives.some((p) => p.__wskit === 'hibernation')).toBe(false);
    expect(handler.__features?.has('hibernation')).toBe(false);
  });

  it('retains one translator factory on the assembled server definition', () => {
    const translate = translator(() => ({ inbound: (raw) => raw }));
    const base = define({ translate });

    expect(base.assemble({ handlers: [] }).__translate).toBe(translate);
  });

  it.each([
    'onInit',
    'onConnect',
    'onDisconnect',
    'onError',
    'onValidationError',
    'onShutdown',
  ] as const)('throws when the %s lifecycle hook is registered twice', (hook) => {
    const base = makeBase();
    (base[hook] as (handler: () => void) => void)(() => {});
    expect(() => (base[hook] as (handler: () => void) => void)(() => {})).toThrow(
      new RegExp(`Duplicate ${hook} hook`),
    );
  });

  it('throws when a second intercept is registered', () => {
    const base = makeBase();
    base.intercept(() => {});
    expect(() => base.intercept(() => {})).toThrow(/Duplicate intercept hook/);
  });

  it('throws when the same event is bound by two handlers passed to assemble', () => {
    const base = makeBase();
    const first = base.on('echo', { input: v.object({ text: v.string() }), run() {} });
    const second = base.on('echo', { input: v.object({ text: v.string() }), run() {} });
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
    const base = define({ capabilities: [clientRequests()] });
    const asEvent = base.on('shared', { input: v.object({}), run() {} });
    const asRequest = base.request('shared', { input: v.object({}), run() {} });
    expect(() => base.assemble({ handlers: [asEvent, asRequest] })).toThrow(
      /Event name 'shared' is bound by both a incoming handler and a request handler/,
    );
  });
});

describe('define({ users }) maxConnections validation', () => {
  it('rejects maxConnections: 0', () => {
    const base = define({
      users: { maxConnections: 0, onExceed: 'replace' },
    });
    expect(() => base.assemble({ handlers: [] })).toThrow(/maxConnections/);
  });

  it('rejects a negative maxConnections', () => {
    const base = define({
      users: { maxConnections: -1, onExceed: 'reject' },
    });
    expect(() => base.assemble({ handlers: [] })).toThrow(/maxConnections/);
  });

  it('rejects a non-integer maxConnections', () => {
    const base = define({
      users: { maxConnections: 2.5, onExceed: 'replace' },
    });
    expect(() => base.assemble({ handlers: [] })).toThrow(/maxConnections/);
  });

  it('accepts a positive integer maxConnections', () => {
    const base = define({
      users: { maxConnections: 3, onExceed: 'replace' },
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });

  it('accepts users config with maxConnections omitted', () => {
    const base = define({
      users: { onExceed: 'reject' },
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });
});
