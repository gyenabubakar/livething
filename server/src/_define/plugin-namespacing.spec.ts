/* oxlint-disable @typescript-eslint/no-explicit-any */
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { error, t } from '~/index.ts';
import { persistence } from '~/persistence/capability.ts';
import { scopeUpgradeHelpers } from '~/plugin-scope.ts';
import { requests } from '~/request/capability.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { stream } from '~/stream/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { plugin } from './plugin.ts';

interface Env {
  SECRET: string;
}

/** Pull a plugin's namespaced incoming handler out of its built primitives. */
function incomingHandler(
  primitives: readonly any[],
  wireEvent: string,
): (ctx: any, payload: any) => any {
  const found = primitives.find((p) => p.__wskit === 'incoming' && p.event === wireEvent);
  if (!found) throw new Error(`no incoming primitive for ${wireEvent}`);
  return found.handler;
}

describe('plugin namespacing — streams', () => {
  it('namespaces a stream event and its nudge under __<id>::', () => {
    const h = define({ scoped: true, capabilities: [stream()] });
    const ticker = h.stream('ticks', {
      input: v.object({}),
      nudges: { faster: null },
      async *run() {
        yield 1;
      },
    });
    const Plug = plugin('acme:ticker', { handler: h.assemble(ticker) });
    const base = define({ env: t<Env>(), capabilities: [Plug()] });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.streams.has('__acme:ticker::ticks')).toBe(true);
    const gen = compiled.streams.get('__acme:ticker::ticks')!;
    expect(gen.stream.nudges.map((n) => n.event)).toContain('__acme:ticker::faster');
  });
});

describe('plugin namespacing — channels', () => {
  it('namespaces the channel name and its child events', () => {
    const h = define({ scoped: true, capabilities: [channels()] });
    const room = h.channel('room', { outgoing: { emits: { msg: t<{ text: string }>() } } });
    const onSay = room.on('say', { input: v.object({ text: v.string() }), run() {} });
    const Plug = plugin('acme:room', { handler: h.assemble(onSay) });
    const base = define({ env: t<Env>(), capabilities: [Plug()] });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.channels.has('__acme:room::room')).toBe(true);
    const ch = compiled.channels.get('__acme:room::room')!;
    expect(ch.incoming.has('__acme:room::say')).toBe(true);
    expect(ch.outgoing.has('__acme:room::msg')).toBe(true);
  });
});

describe('plugin namespacing — scheduled', () => {
  it('registers a plugin task under __<id>::<task> and prefixes ctx.schedule', () => {
    const h = define({ scoped: true, capabilities: [scheduled({ sweep: { every: 1000 } })] });
    const sweep = h.scheduled('sweep', { run() {} });
    const Plug = plugin('acme:presence', { handler: h.assemble(sweep) });
    const base = define({ env: t<Env>(), capabilities: [Plug()] });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.scheduled.has('__acme:presence::sweep')).toBe(true);
  });

  it('prefixes ctx.schedule(task) called from a plugin handler', () => {
    const h = define({
      scoped: true,
      capabilities: [emits({ done: t<{}>() }), scheduled({ sweep: { every: 1000 } })],
    });
    const sweep = h.scheduled('sweep', { run() {} });
    const trigger = h.on('go', {
      input: v.object({}),
      run(ctx) {
        ctx.schedule('sweep', { time: 0 });
      },
    });
    const { __primitives } = plugin('acme:presence', { handler: h.assemble(trigger, sweep) })();
    const incoming = __primitives.find(
      (p: any) => p.__wskit === 'incoming' && p.event === '__acme:presence::go',
    ) as any;
    const schedule = vi.fn();
    incoming.handler({ id: 'c1', schedule }, {});
    expect(schedule).toHaveBeenCalledWith('__acme:presence::sweep', { time: 0 });
  });
});

describe('plugin namespacing — tags', () => {
  it('namespaces a plugin tag group and prefixes ctx.tags lookups', () => {
    const h = define({
      scoped: true,
      capabilities: [
        emits({ done: t<{}>() }),
        tags((ephemeral) => [ephemeral('role', t<string>())]),
      ],
    });
    const handler = h.on('go', {
      input: v.object({}),
      run(ctx) {
        ctx.tags.ephemeral('role').add('admin');
      },
    });
    const Plug = plugin('acme:roles', { handler: h.assemble(handler) })();
    const base = define({ env: t<Env>(), capabilities: [Plug] });
    // Compiles without tripping the identifier guard on the namespaced group.
    expect(() => compileHandlerDefinition(base.assemble())).not.toThrow();

    const incoming = Plug.__primitives.find(
      (p: any) => p.__wskit === 'incoming' && p.event === '__acme:roles::go',
    ) as any;
    const add = vi.fn();
    const ephemeral = vi.fn(() => ({ add }));
    incoming.handler({ id: 'c1', tags: { ephemeral } }, {});
    expect(ephemeral).toHaveBeenCalledWith('__acme:roles::role');
    expect(add).toHaveBeenCalledWith('admin');
  });
});

describe('plugin namespacing — errors', () => {
  it('namespaces plugin error codes under __<id>::', () => {
    const Denied = error('denied', v.object({ why: v.string() }));
    const h = define({ scoped: true, capabilities: [emits({ done: t<{}>() }), errors([Denied])] });
    const handler = h.on('go', { input: v.object({}), run() {} });
    const Plug = plugin('acme:auth', { handler: h.assemble(handler) })();
    const errorsPrimitive = Plug.__primitives.find((p: any) => p.__wskit === 'errors') as any;
    expect(errorsPrimitive.defs.map((d: any) => d.code)).toContain('__acme:auth::denied');

    const registerErrorDefinitions = vi.fn();
    errorsPrimitive.__setup({ registerErrorDefinitions });
    expect(registerErrorDefinitions).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ code: '__acme:auth::denied' })]),
    );
  });
});

describe('plugin namespacing — durable kinds need persistence on the host', () => {
  it('compiles a plugin channel with persistence listed', () => {
    const h = define({ scoped: true, capabilities: [channels()] });
    const room = h.channel('room');
    room.on('say', { input: v.object({}), run() {} });
    const Plug = plugin('acme:room', { handler: h.assemble(room) });
    const base = define({ env: t<Env>(), capabilities: [persistence(), Plug()] });
    expect(() => compileHandlerDefinition(base.assemble())).not.toThrow();
  });
});

describe('plugin namespacing — server→client requests', () => {
  it('prefixes ctx.request / ctx.broadcastRequest event names', () => {
    const h = define({
      scoped: true,
      capabilities: [
        emits({ done: t<{}>() }),
        requests({
          confirm: { out: t<{ q: string }>(), in: v.object({ ok: v.boolean() }) },
          poll: { out: t<{}>(), in: v.object({ v: v.number() }) },
        }),
      ],
    });
    const trigger = h.on('go', {
      input: v.object({}),
      run(ctx: any) {
        ctx.request('confirm', { q: 'sure?' });
        ctx.broadcastRequest('poll', {});
      },
    });
    const { __primitives } = plugin('acme:ask', { handler: h.assemble(trigger) })();
    const handler = incomingHandler(__primitives, '__acme:ask::go');

    const request = vi.fn();
    const broadcastRequest = vi.fn();
    handler({ id: 'c1', request, broadcastRequest }, {});

    expect(request).toHaveBeenCalledWith('__acme:ask::confirm', { q: 'sure?' });
    expect(broadcastRequest).toHaveBeenCalledWith('__acme:ask::poll', {});
  });

  it('prefixes ctx.connection(ref).request event names', () => {
    const h = define({
      scoped: true,
      capabilities: [
        emits({ done: t<{}>() }),
        requests({ confirm: { out: t<{ q: string }>(), in: v.object({ ok: v.boolean() }) } }),
      ],
    });
    const trigger = h.on('go', {
      input: v.object({}),
      run(ctx: any) {
        ctx.connection(ctx.self).request('confirm', { q: 'sure?' });
        ctx.connection(ctx.self).send('done', {});
      },
    });
    const { __primitives } = plugin('acme:ask', { handler: h.assemble(trigger) })();
    const handler = incomingHandler(__primitives, '__acme:ask::go');

    const request = vi.fn();
    const send = vi.fn();
    const connection = vi.fn(() => ({ request, send }));
    handler({ id: 'c1', self: { id: 'c1' }, connection }, {});

    expect(request).toHaveBeenCalledWith('__acme:ask::confirm', { q: 'sure?' });
    expect(send).toHaveBeenCalledWith('__acme:ask::done', {});
  });
});

describe('plugin namespacing — kv keys', () => {
  it('namespaces ctx.kv get / set / delete keys and the list prefix', async () => {
    const h = define({ scoped: true, capabilities: [emits({ done: t<{}>() })] });
    const trigger = h.on('go', {
      input: v.object({}),
      async run(ctx: any) {
        await ctx.kv.set('count', 1);
        await ctx.kv.get('count');
        await ctx.kv.delete('count');
        await ctx.kv.list('c');
        await ctx.kv.list();
      },
    });
    const { __primitives } = plugin('acme:store', { handler: h.assemble(trigger) })();
    const handler = incomingHandler(__primitives, '__acme:store::go');

    const set = vi.fn(async () => {});
    const get = vi.fn(async () => undefined);
    const del = vi.fn(async () => {});
    const list = vi.fn(async () => []);
    await handler({ id: 'c1', kv: { set, get, delete: del, list } }, {});

    expect(set).toHaveBeenCalledWith('__acme:store::count', 1);
    expect(get).toHaveBeenCalledWith('__acme:store::count');
    expect(del).toHaveBeenCalledWith('__acme:store::count');
    expect(list).toHaveBeenNthCalledWith(1, '__acme:store::c');
    // A bare list() scopes to the plugin's whole namespace.
    expect(list).toHaveBeenNthCalledWith(2, '__acme:store::');
  });

  it('strips the namespace prefix off list() results so they round-trip (#7)', async () => {
    const h = define({ scoped: true, capabilities: [emits({ done: t<{}>() })] });
    let listed: string[] = [];
    const trigger = h.on('go', {
      input: v.object({}),
      async run(ctx: any) {
        listed = await ctx.kv.list();
      },
    });
    const { __primitives } = plugin('acme:store', { handler: h.assemble(trigger) })();
    const handler = incomingHandler(__primitives, '__acme:store::go');

    const list = vi.fn(async () => ['__acme:store::count', '__acme:store::seen']);
    await handler({ id: 'c1', kv: { list } }, {});

    expect(list).toHaveBeenCalledWith('__acme:store::');
    expect(listed).toEqual(['count', 'seen']);
  });
});

describe('plugin namespacing — channel runtime sends', () => {
  it('prefixes ctx.channel.send / broadcast event names from a plugin channel handler', () => {
    const h = define({ scoped: true, capabilities: [channels()] });
    const room = h.channel('room', { outgoing: { emits: { roster: t<{ who: string }>() } } });
    room.on('say', {
      input: v.object({}),
      run(ctx: any) {
        ctx.channel.send('roster', { who: 'a' });
        ctx.channel.broadcast('roster', { who: 'b' });
      },
    });
    const { __primitives } = plugin('acme:room', { handler: h.assemble(room) })();
    const channelPrim = __primitives.find((p: any) => p.__wskit === 'channel') as any;
    const child = channelPrim.primitives.find(
      (p: any) => p.__wskit === 'incoming' && p.event === '__acme:room::say',
    ) as any;

    const send = vi.fn();
    const broadcast = vi.fn();
    child.handler({ id: 'c1', channel: { send, broadcast } }, {});

    expect(send).toHaveBeenCalledWith('__acme:room::roster', { who: 'a' });
    expect(broadcast).toHaveBeenCalledWith('__acme:room::roster', { who: 'b' });
  });
});

describe('plugin namespacing — ctx.channels.get is scoped (#8)', () => {
  it('namespaces the get target and the resolved handle event names', () => {
    const h = define({ scoped: true, capabilities: [channels()] });
    const room = h.channel('room', { outgoing: { emits: { roster: t<{ who: string }>() } } });
    room.on('say', { input: v.object({}), run() {} });
    const trigger = h.on('go', {
      input: v.object({}),
      run(ctx: any) {
        ctx.channels.get('room').send('roster', { who: 'a' });
        ctx.channels.get('room').broadcast('roster', { who: 'b' });
      },
    });
    const { __primitives } = plugin('acme:room', { handler: h.assemble(room, trigger) })();
    const handler = incomingHandler(__primitives, '__acme:room::go');

    const send = vi.fn();
    const broadcast = vi.fn();
    const get = vi.fn(() => ({ send, broadcast }));
    handler({ id: 'c1', channels: { get } }, {});

    expect(get).toHaveBeenCalledWith('__acme:room::room');
    expect(send).toHaveBeenCalledWith('__acme:room::roster', { who: 'a' });
    expect(broadcast).toHaveBeenCalledWith('__acme:room::roster', { who: 'b' });
  });

  it('namespaces a channel decl / .at() ref / family pair passed to get', () => {
    const h = define({ scoped: true, capabilities: [channels()] });
    const staticRoom = h.channel('lobby');
    staticRoom.on('say', { input: v.object({}), run() {} });
    const family = h.channel(['rooms', 'room:{id}']);
    family.on('say', { input: v.object({}), run() {} });
    const ref = family.at({ id: 'general' });
    const trigger = h.on('go', {
      input: v.object({}),
      run(ctx: any) {
        ctx.channels.get(staticRoom);
        ctx.channels.get(ref);
        ctx.channels.get('rooms', 'room:general');
      },
    });
    const { __primitives } = plugin('acme:room', {
      handler: h.assemble(staticRoom, family, trigger),
    })();
    const handler = incomingHandler(__primitives, '__acme:room::go');

    const get = vi.fn((..._args: unknown[]) => ({}));
    handler({ id: 'c1', channels: { get } }, {});

    expect(get.mock.calls[0]![0]).toMatchObject({ __key: '__acme:room::lobby' });
    expect(get.mock.calls[1]![0]).toMatchObject({
      family: '__acme:room::rooms',
      name: 'room:general',
    });
    expect(get.mock.calls[2]).toEqual(['__acme:room::rooms', 'room:general']);
  });
});

describe('plugin namespacing — upgrade seeds tags into the plugin namespace (#9)', () => {
  it('namespaces the ephemeral group a plugin upgrade seeds via the sugar form', async () => {
    const h = define({
      scoped: true,
      capabilities: [tags((ephemeral) => [ephemeral('room', t<string>())])],
      upgrade: () => ({ identity: 'u1', tags: { ephemeral: { room: 'general' } } }),
    });
    const go = h.on('go', { input: v.object({}), run() {} });
    const { __primitives } = plugin('acme:rooms', { handler: h.assemble(go) })();
    const upgradePrim = __primitives.find((p: any) => p.__wskit === 'onUpgrade') as any;

    const result = await upgradePrim.handler(new Request('https://x'), {});
    expect(result.tags).toEqual([
      { __wskit: 'tag-ref', kind: 'ephemeral', group: '__acme:rooms::room', key: 'general' },
    ]);
  });

  it('scopeUpgradeHelpers namespaces the group asked of helpers.tags', () => {
    const ref = vi.fn((key: string) => ({ kind: 'ephemeral', group: '<unused>', key }));
    const ephemeral = vi.fn(() => ({ ref }));
    const persistent = vi.fn(() => ({ ref }));
    const scoped = scopeUpgradeHelpers('acme:rooms', { tags: { ephemeral, persistent } });
    scoped.tags.ephemeral('room');
    scoped.tags.persistent('seat');
    expect(ephemeral).toHaveBeenCalledWith('__acme:rooms::room');
    expect(persistent).toHaveBeenCalledWith('__acme:rooms::seat');
  });
});

describe('plugin namespacing — channel outgoing.requests are reachable (#10)', () => {
  it('re-registers a channel server-request under the namespaced channel key + event', () => {
    const h = define({ scoped: true, capabilities: [channels(), requests({})] });
    const room = h.channel('room', {
      outgoing: {
        requests: {
          'confirm-kick': { out: t<{ who: string }>(), in: v.object({ ok: v.boolean() }) },
        },
      },
    });
    room.on('say', { input: v.object({}), run() {} });
    const { __primitives } = plugin('acme:room', { handler: h.assemble(room) })();

    const carrier = __primitives.find((p: any) => p.__wskit === 'server-requests') as any;
    const map: Map<string, any> = carrier.__serverRequests;
    const namespacedKey = JSON.stringify(['__acme:room::room', '__acme:room::confirm-kick']);
    expect(map.has(namespacedKey)).toBe(true);
    expect(map.get(namespacedKey).responseValidator).toBeDefined();
    expect(map.has(JSON.stringify(['room', 'confirm-kick']))).toBe(false);
  });

  it('re-registers a top-level plugin server-request under its namespaced event', () => {
    const h = define({
      scoped: true,
      capabilities: [requests({ confirm: { out: t<{}>(), in: v.object({ ok: v.boolean() }) } })],
    });
    const go = h.on('go', { input: v.object({}), run() {} });
    const { __primitives } = plugin('acme:ask', { handler: h.assemble(go) })();

    const carrier = __primitives.find((p: any) => p.__wskit === 'server-requests') as any;
    const map: Map<string, any> = carrier.__serverRequests;
    expect(map.has(JSON.stringify([null, '__acme:ask::confirm']))).toBe(true);
    expect(map.has(JSON.stringify([null, 'confirm']))).toBe(false);
  });

  it('does not mutate the assembled handler server-request carrier (pure namespacing)', () => {
    const h = define({
      scoped: true,
      capabilities: [requests({ confirm: { out: t<{}>(), in: v.object({ ok: v.boolean() }) } })],
    });
    const go = h.on('go', { input: v.object({}), run() {} });
    const handler = h.assemble(go);
    const original = handler.primitives.find((p: any) => p.__wskit === 'server-requests') as any;
    const originalMap: Map<string, any> = original.__serverRequests;

    plugin('acme:ask', { handler }); // triggers namespacing

    // The handler's own carrier keeps the BARE key — namespacing built a copy,
    // so a second plugin() on the same handler can't double-prefix.
    expect(originalMap.has(JSON.stringify([null, 'confirm']))).toBe(true);
    expect(originalMap.has(JSON.stringify([null, '__acme:ask::confirm']))).toBe(false);
  });
});

describe('plugin namespacing — hook ctx is scoped (Major 4)', () => {
  it('namespaces ctx.send and ctx.kv from a plugin intercept hook', () => {
    const h = define({
      scoped: true,
      capabilities: [emits({ 'own-event': t<{ ok: boolean }>() })],
    });
    h.intercept((ctx: any) => {
      ctx.send('own-event', { ok: true });
      void ctx.kv.set('count', 1);
    });
    const go = h.on('go', { input: v.object({}), run() {} });
    const { __primitives } = plugin('acme:presence', { handler: h.assemble(go) })();
    const interceptPrim = __primitives.find((p: any) => p.__wskit === 'intercept') as any;
    expect(interceptPrim.__owner).toEqual({ kind: 'plugin', id: 'acme:presence' });

    const send = vi.fn();
    const kvSet = vi.fn();
    interceptPrim.handler({ id: 'c1', send, kv: { set: kvSet } }, { event: 'go', payload: {} });
    expect(send).toHaveBeenCalledWith('__acme:presence::own-event', { ok: true });
    expect(kvSet).toHaveBeenCalledWith('__acme:presence::count', 1);
  });

  it('namespaces ctx.send from a plugin outgoing hook', () => {
    const h = define({ scoped: true, capabilities: [emits({ 'own-event': t<{}>() })] });
    h.outgoing((ctx: any) => {
      ctx.send('own-event', {});
    });
    const go = h.on('go', { input: v.object({}), run() {} });
    const { __primitives } = plugin('acme:store', { handler: h.assemble(go) })();
    const hook = __primitives.find((p: any) => p.__wskit === 'outgoingHook') as any;
    expect(hook.__owner).toEqual({ kind: 'plugin', id: 'acme:store' });

    let registered: any;
    hook.__setup({ onOutgoing: (fn: any) => (registered = fn) });
    const send = vi.fn();
    registered({ id: 'c1', send }, { event: 'x', payload: {} });
    expect(send).toHaveBeenCalledWith('__acme:store::own-event', {});
  });

  it('passes a nullish outgoing-hook ctx through without proxying (broadcast safety)', () => {
    const h = define({ scoped: true });
    let received: any = 'unset';
    h.outgoing((ctx: any) => {
      received = ctx;
    });
    const go = h.on('go', { input: v.object({}), run() {} });
    const { __primitives } = plugin('acme:obs', { handler: h.assemble(go) })();
    const hook = __primitives.find((p: any) => p.__wskit === 'outgoingHook') as any;
    let registered: any;
    hook.__setup({ onOutgoing: (fn: any) => (registered = fn) });
    expect(() => registered(undefined, { event: 'x', payload: {} })).not.toThrow();
    expect(received).toBeUndefined();
  });
});

describe('plugin namespacing — channel hook is owned and scoped (Major 5)', () => {
  it('owner-stamps and scopes a plugin channel intercept child', () => {
    const h = define({ scoped: true, capabilities: [channels()] });
    const room = h.channel('room', { outgoing: { emits: { roster: t<{ who: string }>() } } });
    room.intercept((ctx: any) => {
      ctx.channel.send('roster', { who: 'a' });
    });
    room.on('say', { input: v.object({}), run() {} });
    const { __primitives } = plugin('acme:room', { handler: h.assemble(room) })();
    const channelPrim = __primitives.find((p: any) => p.__wskit === 'channel') as any;
    const interceptChild = channelPrim.primitives.find(
      (p: any) => p.__wskit === 'intercept',
    ) as any;
    expect(interceptChild.__owner).toEqual({ kind: 'plugin', id: 'acme:room' });

    const send = vi.fn();
    interceptChild.handler({ id: 'c1', channel: { send } }, { event: 'say', payload: {} });
    expect(send).toHaveBeenCalledWith('__acme:room::roster', { who: 'a' });
  });

  it('a plugin channel name does not collide with an app channel of the same name', () => {
    const h = define({ scoped: true, capabilities: [channels()] });
    const pGames = h.channel('games', { outgoing: { emits: { tick: t<{}>() } } });
    pGames.on('play', { input: v.object({}), run() {} });
    const base = define({
      env: t<Env>(),
      capabilities: [channels(), plugin('acme:arcade', { handler: h.assemble(pGames) })()],
    });
    const appGames = base.channel('games', { outgoing: { emits: { tock: t<{}>() } } });
    appGames.on('move', { input: v.object({}), run() {} });
    const compiled = compileHandlerDefinition(base.assemble(appGames));

    // The app keeps the bare name; the plugin's channel is namespaced — distinct
    // keys, no collision.
    expect(compiled.channels.has('games')).toBe(true);
    expect(compiled.channels.has('__acme:arcade::games')).toBe(true);
  });
});

describe('plugin namespacing — app ctx is untouched', () => {
  it('does not prefix events / kv keys for a non-plugin app handler', async () => {
    const base = define({
      env: t<Env>(),
      capabilities: [
        emits({ done: t<{}>() }),
        requests({ confirm: { out: t<{}>(), in: v.object({ ok: v.boolean() }) } }),
      ],
    });
    const send = vi.fn();
    const request = vi.fn();
    const kvSet = vi.fn(async () => {});

    const trigger = base.on('go', {
      input: v.object({}),
      async run(ctx: any) {
        ctx.send('done', {});
        ctx.request('confirm', {});
        await ctx.kv.set('count', 1);
      },
    });
    const incoming = base
      .assemble(trigger)
      .primitives.find((p: any) => p.__wskit === 'incoming' && p.event === 'go') as any;

    await incoming.handler({ id: 'c1', send, request, kv: { set: kvSet } }, {});

    expect(send).toHaveBeenCalledWith('done', {});
    expect(request).toHaveBeenCalledWith('confirm', {});
    expect(kvSet).toHaveBeenCalledWith('count', 1);
  });
});
