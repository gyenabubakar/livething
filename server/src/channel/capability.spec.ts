/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { requests } from '~/request/capability.ts';
import { serverRequestKey } from '~/request/outgoing-runtime.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { channels } from './capability.ts';

interface Env {
  SECRET: string;
}

function channelPrimitive(primitives: readonly { __wskit: string }[]): any {
  const found = primitives.find((p) => p.__wskit === 'channel');
  if (!found) throw new Error('no channel primitive');
  return found;
}

describe('channels() capability', () => {
  it('registers a static channel with its emits and handler', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const lobby = base.channel('lobby', {
      outgoing: { emits: { joined: t<{ id: string }>() } },
    });
    const handleChat = lobby.on('chat', { input: v.object({ text: v.string() }), run() {} });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [handleChat] }));
    const channel = compiled.channels.get('lobby');
    expect(channel?.incoming.has('chat')).toBe(true);
    expect(channel?.outgoing.has('joined')).toBe(true);
  });

  it('registers a dynamic channel family', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel(['rooms', 'rooms:{id}'], {
      outgoing: { emits: { said: t<{ text: string }>() } },
    });
    const handleSay = room.on('say', { input: v.object({ text: v.string() }), run() {} });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [handleSay] }));
    expect(compiled.channelFamilies.has('rooms')).toBe(true);
  });

  describe('.at(params) ref resolution and guardrails', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });

    it('fills a family template into a concrete channel ref', () => {
      const rooms = base.channel(['rooms', 'room:{id}']);
      const ref = rooms.at({ id: 'general' });
      expect(ref).toEqual({ __wskitChannelRef: true, family: 'rooms', name: 'room:general' });
    });

    it('fills a multi-param template', () => {
      const threads = base.channel(['threads', 'org:{org}/thread:{tid}']);
      expect(threads.at({ org: 'acme', tid: '42' })).toEqual({
        __wskitChannelRef: true,
        family: 'threads',
        name: 'org:acme/thread:42',
      });
    });

    it('throws on a static channel (no .at)', () => {
      const lobby = base.channel('lobby') as any;
      expect(() => lobby.at({ id: 'x' })).toThrow(/only available on dynamic family channels/);
    });

    it('throws when a declared param is missing', () => {
      const rooms = base.channel(['rooms', 'room:{id}']) as any;
      expect(() => rooms.at({})).toThrow(/needs a non-empty 'id'/);
    });

    it('throws when a declared param is empty', () => {
      const rooms = base.channel(['rooms', 'room:{id}']);
      expect(() => rooms.at({ id: '' })).toThrow(/needs a non-empty 'id'/);
    });
  });

  it('pulls in the whole channel — gates and lifecycle — from one handler', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', { outgoing: { emits: { said: t<{ text: string }>() } } });
    room.subscribe(() => {});
    const handleSay = room.on('say', { input: v.object({}), run() {} });
    const primitive = channelPrimitive(base.assemble({ handlers: [handleSay] }).primitives);
    const childKinds = primitive.primitives.map((p: { __wskit: string }) => p.__wskit);
    expect(childKinds).toContain('onSubscribe');
    expect(childKinds).toContain('incoming');
  });

  it('assembles a handler-less channel passed directly', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const presence = base.channel('presence', {
      outgoing: { emits: { tick: t<{}>() } },
    });
    presence.subscribe(() => {});
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [presence] }));
    expect(compiled.channels.has('presence')).toBe(true);
  });

  it('dedupes a channel passed both directly and via a handler', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', { outgoing: { emits: { said: t<{ text: string }>() } } });
    const handleSay = room.on('say', { input: v.object({}), run() {} });
    const channelCount = base
      .assemble({ handlers: [room, handleSay] })
      .primitives.filter((p) => p.__wskit === 'channel').length;
    expect(channelCount).toBe(1);
  });

  it('exposes the family key as ctx.channel.family at runtime', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', { outgoing: { emits: { said: t<{ text: string }>() } } });
    let seenFamily: unknown;
    room.on('say', {
      input: v.object({}),
      run(ctx) {
        seenFamily = ctx.channel.family;
      },
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [room] }).primitives);
    const incoming = primitive.primitives.find(
      (p: { __wskit: string; event?: string }) => p.__wskit === 'incoming' && p.event === 'say',
    );
    incoming.handler({ channel: { family: 'rooms' } }, {});
    expect(seenFamily).toBe('rooms');
  });

  it('runs the check gate with the validated payload as the input argument and forwards to commit', async () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    let seenCheck: unknown;
    let seenCommit: unknown;
    const room = base.channel('room', {
      outgoing: { emits: { said: t<{ text: string }>() } },
      subscribe: v.object({ token: v.string() }),
      check(_ctx, input) {
        seenCheck = input;
        return { role: 'member' };
      },
      commit(_ctx, result) {
        seenCommit = result;
      },
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [room] }).primitives);
    const checkChild = primitive.primitives.find((p: { __wskit: string }) => p.__wskit === 'check');
    expect(checkChild.validator).toBeDefined();
    const result = await checkChild.handler({ channel: { scope: null } }, { token: 'x' });
    expect(seenCheck).toEqual({ token: 'x' });
    expect(result).toEqual({ role: 'member' });

    const commitChild = primitive.primitives.find(
      (p: { __wskit: string }) => p.__wskit === 'commit',
    );
    commitChild.handler({ channel: { scope: null } }, { role: 'member' });
    expect(seenCommit).toEqual({ role: 'member' });
  });

  it('attaches the subscribe validator even when the channel has no check handler (bug #5)', async () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', {
      subscribe: v.object({ token: v.string() }),
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [room] }).primitives);
    const checkChild = primitive.primitives.find((p: { __wskit: string }) => p.__wskit === 'check');
    expect(checkChild).toBeDefined();
    expect(checkChild.validator).toBeDefined();
    const ctx: { channel: { scope: null }; check?: unknown } = { channel: { scope: null } };
    const result = await checkChild.handler(ctx, { token: 'x' });
    expect(result).toBeUndefined();
  });

  it('runs the revalidate gate', async () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    let ran = false;
    const room = base.channel('room', {
      revalidate() {
        ran = true;
      },
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [room] }).primitives);
    const child = primitive.primitives.find((p: { __wskit: string }) => p.__wskit === 'revalidate');
    await child.handler({ channel: { scope: null } });
    expect(ran).toBe(true);
  });

  it('responds to a channel request with the return value', async () => {
    const base = define({ env: t<Env>(), capabilities: [channels(), requests()] });
    const room = base.channel('room', {});
    room.request('info', {
      input: v.object({}),
      run() {
        return { ok: true };
      },
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [room] }).primitives);
    const requestChild = primitive.primitives.find(
      (p: { __wskit: string; event?: string }) => p.__wskit === 'request' && p.event === 'info',
    );
    const respond = vi.fn();
    await requestChild.handler({ respond, channel: { scope: null } }, {});
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it('carries handler scheduling options through channel compilation', () => {
    const base = define({ env: t<Env>(), capabilities: [channels(), requests()] });
    const room = base.channel('room', {});
    const ordered = room.on('ordered', { run() {} });
    const interleaved = room.on('interleaved', { allowInterleaving: true, run() {} });
    const request = room.request('request', { allowInterleaving: false, run() {} });
    const compiled = compileHandlerDefinition(
      base.assemble({ handlers: [ordered, interleaved, request] }),
    );
    const channel = compiled.channels.get('room')!;

    expect(channel.incoming.get('ordered')?.allowInterleaving).toBe(false);
    expect(channel.incoming.get('interleaved')?.allowInterleaving).toBe(true);
    expect(channel.requests.get('request')?.allowInterleaving).toBe(false);
  });

  it('runs a channel stream generator with both the stream and channel handles', async () => {
    const base = define({ env: t<Env>(), capabilities: [channels(), stream()] });
    const room = base.channel('room', {});
    room.stream('feed', {
      input: v.object({}),
      async *run(ctx) {
        yield { family: ctx.channel.family };
      },
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [room] }).primitives);
    const streamChild = primitive.primitives.find(
      (p: { __wskit: string; event?: string }) =>
        p.__wskit === 'stream-generate' && p.event === 'feed',
    );
    const ctx: any = {
      nudges: (value: unknown) => (Array.isArray(value) ? value : []),
      channel: { family: 'rooms' },
    };
    const iterator = streamChild.generator(ctx, {});
    const first = await iterator.next();
    expect(first.value).toEqual({ family: 'rooms' });
  });

  it('throws when a lifecycle hook is registered twice', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', {});
    room.subscribe(() => {});
    expect(() => room.subscribe(() => {})).toThrow(/Duplicate subscribe on channel 'room'/);
  });

  it('throws when a channel request is used without the requests() capability', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', {}) as unknown as {
      request(event: string, config: { input?: unknown; run: () => unknown }): unknown;
    };
    expect(() => room.request('info', { input: v.object({}), run: () => ({}) })).toThrow(
      /uses request\(\) but the requests\(\) capability is not/,
    );
  });

  it('throws when a channel declares outgoing.requests without the requests() capability', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const escapeHatch = base as unknown as {
      channel(name: string, config?: any): unknown;
    };
    expect(() =>
      escapeHatch.channel('room', {
        outgoing: {
          requests: {
            'confirm-kick': { out: t<{ target: string }>(), in: v.object({ ok: v.boolean() }) },
          },
        },
      }),
    ).toThrow(/declares outgoing\.requests but the requests\(\) capability is not listed/);
  });

  it('registers channel outgoing.requests with the requests() capability', () => {
    const reqCap = requests();
    const base = define({ env: t<Env>(), capabilities: [reqCap, channels()] });
    base.channel('room', {
      outgoing: {
        requests: {
          'confirm-kick': { out: t<{ target: string }>(), in: v.object({ ok: v.boolean() }) },
          vol: { out: t<{}>(), in: v.object({ r: v.boolean() }) },
        },
      },
    });
    const declarations = (reqCap as unknown as { __serverRequests: ReadonlyMap<string, any> })
      .__serverRequests;
    // Channel declarations are keyed by the channel definition so they never collide
    // with another channel's or with a top-level declaration of the same name.
    expect(
      declarations.get(serverRequestKey('room', 'confirm-kick'))?.responseValidator,
    ).toBeDefined();
    expect(declarations.get(serverRequestKey('room', 'vol'))?.responseValidator).toBeDefined();
    // The bare event name is NOT a key (the collision fix).
    expect(declarations.get('confirm-kick')).toBeUndefined();
  });

  it('throws when a channel stream is used without the stream() capability', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', {});
    // stream() is type-gated off this channel; reach it through an escape hatch
    // to prove the runtime guard still fires as defense in depth.
    const escapeHatch = room as unknown as { stream(event: string, config: any): unknown };
    expect(() => escapeHatch.stream('feed', { input: v.object({}), async *run() {} })).toThrow(
      /uses stream\(\) but the stream\(\) capability is not listed/,
    );
  });

  it('throws when a custom channel replay is used without the replay.custom() capability', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', {});
    expect(() => room.replay({ replay() {} })).toThrow(
      /replay\.custom\(\) capability is\s+not listed/,
    );
  });

  it('throws when base.channel() is used without the channels() capability', () => {
    const base = define({ env: t<Env>() });
    const escapeHatch = base as unknown as { channel(name: string, config?: any): unknown };
    expect(() => escapeHatch.channel('x', {})).toThrow(
      /base\.channel\(\) needs the channels\(\) capability/,
    );
  });
});
