/* oxlint-disable @typescript-eslint/no-explicit-any */
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { error, t } from '~/index.ts';
import { persistence } from '~/persistence/capability.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { stream } from '~/stream/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { plugin } from './plugin.ts';

interface Env {
  SECRET: string;
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
    const base = define({ env: t<Env>(), capabilities: [Plug] });
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
    const base = define({ env: t<Env>(), capabilities: [Plug] });
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
    const base = define({ env: t<Env>(), capabilities: [Plug] });
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
    const { __primitives } = plugin('acme:presence', { handler: h.assemble(trigger, sweep) });
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
    const Plug = plugin('acme:roles', { handler: h.assemble(handler) });
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
    const Plug = plugin('acme:auth', { handler: h.assemble(handler) });
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
    const base = define({ env: t<Env>(), capabilities: [persistence(), Plug] });
    expect(() => compileHandlerDefinition(base.assemble())).not.toThrow();
  });
});
