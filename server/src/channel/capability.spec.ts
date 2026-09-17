/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { emits } from '~/emits/emits.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequestKey } from '~/request/outgoing-runtime.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { channels } from './capability.ts';

function channelPrimitive(primitives: readonly { __wskit: string }[]): any {
  const found = primitives.find((p) => p.__wskit === 'channel');
  if (!found) throw new Error('no channel primitive');

  return found;
}

describe('channels() capability', () => {
  it('registers events and outbound requests from channel capabilities', () => {
    const base = server({
      capabilities: [channels(), serverRequests()],
    });
    const room = base.channel('room', {
      capabilities: [
        emits({ joined: t<{ id: string }>() }),
        serverRequests({
          confirm: { out: t<{ id: string }>(), in: v.object({ ok: v.boolean() }) },
        }),
      ],
    });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [room] }));
    expect(compiled.channels.get('room')?.outgoing.has('joined')).toBe(true);
  });

  it('registers a static channel with its emits and handler', () => {
    const base = server({ capabilities: [channels()] });
    const lobby = base.channel('lobby', {
      capabilities: [emits({ joined: t<{ id: string }>() })],
    });
    const handleChat = lobby.on('chat', { input: v.object({ text: v.string() }), run() {} });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [handleChat] }));
    const channel = compiled.channels.get('lobby');

    expect(channel?.incoming.has('chat')).toBe(true);
    expect(channel?.outgoing.has('joined')).toBe(true);
  });

  it('registers a dynamic channel family', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel(['rooms', 'rooms:{id}'], {
      capabilities: [emits({ said: t<{ text: string }>() })],
    });
    const handleSay = room.on('say', { input: v.object({ text: v.string() }), run() {} });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [handleSay] }));
    expect(compiled.channelFamilies.has('rooms')).toBe(true);
  });

  describe('.at(params) ref resolution and guardrails', () => {
    const base = server({ capabilities: [channels()] });

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

  it('pulls in channel configuration and lifecycle with one selected handler', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', { capabilities: [emits({ said: t<{ text: string }>() })] });
    room.subscribe(() => {});
    const handleSay = room.on('say', { input: v.object({}), run() {} });
    const primitive = channelPrimitive(base.assemble({ handlers: [handleSay] }).primitives);

    const childKinds = primitive.primitives.map((p: { __wskit: string }) => p.__wskit);
    expect(childKinds).toContain('onSubscribe');
    expect(childKinds).toContain('incoming');
  });

  it('assembles a handler-less channel passed directly', () => {
    const base = server({ capabilities: [channels()] });
    const presence = base.channel('presence', {
      capabilities: [emits({ tick: t<{}>() })],
    });
    presence.subscribe(() => {});
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [presence] }));
    expect(compiled.channels.has('presence')).toBe(true);
  });

  it('dedupes a channel passed both directly and via a handler', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', { capabilities: [emits({ said: t<{ text: string }>() })] });
    const handleSay = room.on('say', { input: v.object({}), run() {} });
    const channelCount = base
      .assemble({ handlers: [room, handleSay] })
      .primitives.filter((p) => p.__wskit === 'channel').length;
    expect(channelCount).toBe(1);
  });

  it('exposes the family key as ctx.channel.family at runtime', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', { capabilities: [emits({ said: t<{ text: string }>() })] });
    let seenFamily: unknown;
    const say = room.on('say', {
      input: v.object({}),
      run(ctx) {
        seenFamily = ctx.channel.family;
      },
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [say] }).primitives);

    const incoming = primitive.primitives.find(
      (p: { __wskit: string; event?: string }) => p.__wskit === 'incoming' && p.event === 'say',
    );
    incoming.handler({ channel: { family: 'rooms' } }, {});
    expect(seenFamily).toBe('rooms');
  });

  it('runs the check gate with the validated payload as the input argument and forwards to commit', async () => {
    const base = server({ capabilities: [channels()] });
    let seenCheck: unknown;
    let seenCommit: unknown;
    const room = base.channel('room', {
      capabilities: [emits({ said: t<{ text: string }>() })],
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
    const base = server({ capabilities: [channels()] });
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
    const base = server({ capabilities: [channels()] });
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
    const base = server({ capabilities: [channels(), clientRequests()] });
    const room = base.channel('room', {});
    const info = room.request('info', {
      input: v.object({}),
      run() {
        return { ok: true };
      },
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [info] }).primitives);
    const requestChild = primitive.primitives.find(
      (p: { __wskit: string; event?: string }) => p.__wskit === 'request' && p.event === 'info',
    );

    const respond = vi.fn();
    await requestChild.handler({ respond, channel: { scope: null } }, {});
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it('carries handler scheduling options through channel compilation', () => {
    const base = server({ capabilities: [channels(), clientRequests()] });
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
    const base = server({ capabilities: [channels(), stream()] });
    const room = base.channel('room', {});
    const feed = room.stream('feed', {
      input: v.object({}),
      async *run(ctx) {
        yield { family: ctx.channel.family };
      },
    });
    const primitive = channelPrimitive(base.assemble({ handlers: [feed] }).primitives);
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
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {});
    room.subscribe(() => {});
    expect(() => room.subscribe(() => {})).toThrow(/Duplicate subscribe on channel 'room'/);
  });

  it('throws when a channel request is used without the clientRequests() capability', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {}) as unknown as {
      request(event: string, config: { input?: unknown; run: () => unknown }): unknown;
    };
    expect(() => room.request('info', { input: v.object({}), run: () => ({}) })).toThrow(
      /uses request\(\) but clientRequests\(\) is not/,
    );
  });

  it('throws when a channel declares serverRequests without the root runtime', () => {
    const base = server({ capabilities: [channels()] });
    const escapeHatch = base as unknown as {
      channel(name: string, config?: any): unknown;
    };
    expect(() =>
      escapeHatch.channel('room', {
        capabilities: [
          serverRequests({
            'confirm-kick': { out: t<{ target: string }>(), in: v.object({ ok: v.boolean() }) },
          }),
        ],
      }),
    ).toThrow(/declares serverRequests\(\.\.\.\) but serverRequests\(\) is not listed/);
  });

  it('rejects a channel capability listed more than once', () => {
    const base = server({ capabilities: [channels(), serverRequests()] });

    expect(() =>
      base.channel('room', {
        capabilities: [
          serverRequests({ ask: { out: t<{}>(), in: v.object({ first: v.boolean() }) } }),
          serverRequests({ ask: { out: t<{}>(), in: v.object({ second: v.boolean() }) } }),
        ] as never,
      }),
    ).toThrow(/serverRequests\(\) is listed more than once/);
  });

  it('registers channel serverRequests with the root runtime', () => {
    const reqCap = serverRequests();
    const base = server({ capabilities: [reqCap, channels()] });
    base.channel('room', {
      capabilities: [
        serverRequests({
          'confirm-kick': { out: t<{ target: string }>(), in: v.object({ ok: v.boolean() }) },
          vol: { out: t<{}>(), in: v.object({ r: v.boolean() }) },
        }),
      ],
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
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {});
    // stream() is type-gated off this channel; reach it through an escape hatch
    // to prove the runtime guard still fires as defense in depth.
    const escapeHatch = room as unknown as { stream(event: string, config: any): unknown };
    expect(() => escapeHatch.stream('feed', { input: v.object({}), async *run() {} })).toThrow(
      /uses stream\(\) but the stream\(\) capability is not listed/,
    );
  });

  it('throws when a custom channel replay is used without the replay.custom() capability', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {});
    expect(() => room.replay({ replay() {} })).toThrow(
      /replay\.custom\(\) capability is\s+not listed/,
    );
  });

  it('throws when base.channel() is used without the channels() capability', () => {
    const base = server({});
    const escapeHatch = base as unknown as { channel(name: string, config?: any): unknown };
    expect(() => escapeHatch.channel('x', {})).toThrow(
      /base\.channel\(\) needs the channels\(\) capability/,
    );
  });
});
