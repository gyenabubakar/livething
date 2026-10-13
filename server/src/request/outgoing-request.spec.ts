/* oxlint-disable @typescript-eslint/no-explicit-any */
import { RequestInvalidResponse } from '@livething/core';
import { ENGINE_CHANNEL_META } from '~/_engine/contexts/contexts.ts';
import { CrossInstanceRef } from '~/errors/errors.ts';
import { makeServerRequestsPrimitive, serverRequestKey } from '~/request/outgoing-runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRef } from '~/context.ts';
import type { ResolvedServerRequest } from '~/request/capability.ts';

/** Re-key a bare-event declaration map under one channel's definition key. */
function channelDeclarations(
  channelKey: string,
  entries: ReadonlyMap<string, ResolvedServerRequest>,
): Map<string, ResolvedServerRequest> {
  return new Map(
    [...entries].map(([event, declaration]) => [serverRequestKey(channelKey, event), declaration]),
  );
}

/** Re-key a bare-event declaration map as TOP-LEVEL declarations (channelKey null). */
function topDeclarations(
  entries: ReadonlyMap<string, ResolvedServerRequest>,
): Map<string, ResolvedServerRequest> {
  return new Map(
    [...entries].map(([event, declaration]) => [serverRequestKey(null, event), declaration]),
  );
}

/**
 * Drive the install primitive against a fake `EngineAccess`, capturing the
 * hooks/extenders it registers so a test can simulate sends, answers, and
 * disconnects without a full engine.
 */
function install(declarations: ReadonlyMap<string, ResolvedServerRequest>) {
  let answerHook!: (id: string, frame: any) => boolean;
  let disconnectHook!: (ctx: any) => void;
  let extender!: (ctx: any) => Record<string, unknown>;
  let idCounter = 0;
  const sent: Array<{ connectionId: string; opts: any }> = [];

  const live = new Set<string>(['c1', 'peer']);

  const engine = {
    generateId: (prefix?: string) => `${prefix}_${(idCounter += 1)}`,
    onAnswerFrame: (h: any) => (answerHook = h),
    onDisconnect: (h: any) => (disconnectHook = h),
    extendContext: (factory: any) => (extender = factory),
    sendServerRequest: (connectionId: string, opts: any) => {
      sent.push({ connectionId, opts });
      return live.has(connectionId);
    },
  };

  makeServerRequestsPrimitive(declarations).__setup!(engine as any);

  /** A fake `ConnectionInfo` for one member — only the bits the runtime reads. */
  function member(id: string): any {
    return {
      id,
      userId: id,
      ref: () => ({ __livething: 'connection-ref', id, instance: undefined, userId: id }),
    };
  }

  function buildCtx(
    connectionId: string | undefined,
    scope?: any,
    opts?: {
      channel?: any;
      connections?: string[];
      channels?: Record<string, string[]>;
      tags?: { group?: string[]; refs?: Record<string, string[]> };
      user?: string[];
    },
  ): any {
    const ctx: any = {
      connection: {
        __livething: 'connection-ref',
        id: connectionId,
        instance: undefined,
        userId: 'i',
      },
      [ENGINE_CHANNEL_META]: scope ?? {},
      connections: {
        get: (ref: ConnectionRef) => ({ send: () => true, __ref: ref }),
        all: () => (opts?.connections ?? []).map(member),
      },
    };

    function userHandle(ids: string[]) {
      return { id: ids[0], connections: () => ids.map(member) };
    }

    if (opts?.user) {
      for (const id of opts.user) live.add(id);
      ctx.user = userHandle(opts.user);
      ctx.users = { get: (_id: string) => userHandle(opts!.user!) };
    }

    for (const id of [
      ...(opts?.connections ?? []),
      ...Object.values(opts?.channels ?? {}).flat(),
      ...(opts?.tags?.group ?? []),
      ...Object.values(opts?.tags?.refs ?? {}).flat(),
    ]) {
      live.add(id);
    }

    if (opts?.channels) {
      ctx.channels = {
        get: (name: string) => ({
          name,
          family: null,
          members: () => (opts.channels![name] ?? []).map(member),
        }),
      };
    }

    function makeGroup() {
      return {
        connections: () => (opts!.tags!.group ?? []).map(member),
        ref: (key: string) => ({
          connections: () => (opts!.tags!.refs?.[key] ?? []).map(member),
        }),
      };
    }

    if (opts?.tags) {
      ctx.tags = { ephemeral: makeGroup, persistent: makeGroup };
    }

    // The core attaches ctx.channel before contextExtenders run, so mirror that.
    if (opts?.channel) ctx.channel = opts.channel;
    Object.assign(ctx, extender(ctx));

    return ctx;
  }

  return { answerHook, disconnectHook, buildCtx, sent, live, member };
}

const PERMISSION = new Map<string, ResolvedServerRequest>([
  ['ask', { responseValidator: v.object({ allowed: v.boolean() }) }],
]);

describe('server→client request — outgoing runtime', () => {
  it('ctx.request resolves with the validated answer', async () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'delete' });

    expect(env.sent).toHaveLength(1);
    const { correlationId } = env.sent[0]!.opts;
    expect(env.sent[0]!.opts.event).toBe('ask');

    const handled = env.answerHook('c1', {
      event: 'ask',
      payload: { allowed: true },
      livething: { correlationId },
    });
    expect(handled).toBe(true);
    await expect(promise).resolves.toEqual({ allowed: true });
  });

  it('ctx.request on a bare-marker ack resolves undefined even if the answer carries a payload', async () => {
    const env = install(topDeclarations(new Map([['ping', {}]])));
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ping', {});
    const { correlationId } = env.sent[0]!.opts;

    const handled = env.answerHook('c1', {
      event: 'ping',
      payload: { sneaky: true },
      livething: { correlationId },
    });
    expect(handled).toBe(true);
    await expect(promise).resolves.toBeUndefined();
  });

  it('ctx.request rejects undeclared events before sending a wire request', async () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');

    await expect(ctx.request('missing', {})).rejects.toMatchObject({
      code: 'request-not-declared',
      detail: { event: 'missing' },
    });
    expect(env.sent).toHaveLength(0);
  });

  it('rejects with the typed error when the client declines via __error__', async () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'delete' });
    const { correlationId } = env.sent[0]!.opts;

    const handled = env.answerHook('c1', {
      event: '__error__',
      payload: { code: 'request-no-response' },
      livething: { correlationId },
    });
    expect(handled).toBe(true);
    await expect(promise).rejects.toMatchObject({ code: 'request-no-response' });
  });

  it('rejects with request-invalid-response when the answer fails its schema', async () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'x' });
    const { correlationId } = env.sent[0]!.opts;

    env.answerHook('c1', {
      event: 'ask',
      payload: { allowed: 'nope' },
      livething: { correlationId },
    });
    await expect(promise).rejects.toSatisfy((e: unknown) => RequestInvalidResponse.matches(e));
  });

  it('rejects with timeout when no answer arrives', async () => {
    vi.useFakeTimers();
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'x' }, { timeout: 1000 });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });

    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    vi.useRealTimers();
  });

  it('rejects with disconnected when the target is not live', async () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    env.live.delete('c1');
    await expect(ctx.request('ask', { action: 'x' })).rejects.toMatchObject({
      code: 'disconnected',
    });
  });

  it('rejects pending requests for a connection that disconnects', async () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'x' });
    env.disconnectHook({ connection: { id: 'c1' } });
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('ctx.connections.get(ref).request targets the addressed peer', async () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    const ref: ConnectionRef = {
      __livething: 'connection-ref',
      id: 'peer',
      instance: undefined,
      userId: 'p',
    };

    const promise = ctx.connections.get(ref).request('ask', { action: 'x' });
    expect(env.sent[0]!.connectionId).toBe('peer');

    const { correlationId } = env.sent[0]!.opts;
    env.answerHook('peer', {
      event: 'ask',
      payload: { allowed: false },
      livething: { correlationId },
    });
    await expect(promise).resolves.toEqual({ allowed: false });
  });

  it('ctx.connections.get(ref).request to another instance throws cross-instance', () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    const ref: ConnectionRef = {
      __livething: 'connection-ref',
      id: 'peer',
      instance: 'other',
      userId: 'p',
    };

    expect(() => ctx.connections.get(ref).request('ask', { action: 'x' })).toThrow(
      /cross-instance-ref/,
    );
    try {
      ctx.connections.get(ref).request('ask', { action: 'x' });
    } catch (error) {
      expect(CrossInstanceRef.matches(error)).toBe(true);
    }
  });

  it('ctx.channel.request stamps the channel routing', async () => {
    const env = install(channelDeclarations('rooms', PERMISSION));
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      { channel: { name: 'room-1', family: 'rooms', send: () => true } },
    );
    const promise = ctx.channel.request('ask', { action: 'x' });
    expect(env.sent[0]!.opts.channel).toBe('room-1');
    expect(env.sent[0]!.opts.channelFamily).toBe('rooms');

    const { correlationId } = env.sent[0]!.opts;
    env.answerHook('c1', {
      event: 'ask',
      payload: { allowed: true },
      livething: { correlationId },
    });
    await expect(promise).resolves.toEqual({ allowed: true });
  });

  it('ctx.channel.request rejects names missing from that channel declaration map', async () => {
    const env = install(channelDeclarations('rooms', PERMISSION));
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      { channel: { name: 'room-1', family: 'rooms', send: () => true } },
    );

    await expect(ctx.channel.request('missing', {})).rejects.toMatchObject({
      code: 'request-not-declared',
      detail: { event: 'missing' },
    });
    expect(env.sent).toHaveLength(0);
  });

  it('ctx.channel.request({ to }) asks only the targeted member and resolves the bare response', async () => {
    const env = install(channelDeclarations('rooms', PERMISSION));
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      {
        channel: {
          name: 'room-1',
          family: 'rooms',
          send: () => true,
          members: () => ['c1', 'peer'].map(env.member),
        },
      },
    );

    const promise = ctx.channel.request(
      'ask',
      { action: 'x' },
      {
        to: { __livething: 'connection-ref', id: 'peer', instance: undefined, userId: 'peer' },
      },
    );

    // Only the targeted member is asked, and the frame is channel-stamped.
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]!.connectionId).toBe('peer');
    expect(env.sent[0]!.opts.channel).toBe('room-1');
    const { correlationId } = env.sent[0]!.opts;
    env.answerHook('peer', {
      event: 'ask',
      payload: { allowed: true },
      livething: { correlationId },
    });

    // The targeted form resolves the bare response — no `{ response, from }`.
    await expect(promise).resolves.toEqual({ allowed: true });
  });

  it('ctx.channel.request({ to }) rejects a cross-instance ConnectionRef before local matching', () => {
    const env = install(channelDeclarations('rooms', PERMISSION));
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      {
        channel: {
          name: 'room-1',
          family: 'rooms',
          send: () => true,
          members: () => [env.member('peer')],
        },
      },
    );

    expect(() =>
      ctx.channel.request(
        'ask',
        { action: 'x' },
        {
          to: { __livething: 'connection-ref', id: 'peer', instance: 'other', userId: 'peer' },
        },
      ),
    ).toThrow(/cross-instance-ref/);
    expect(env.sent).toHaveLength(0);
  });

  it('ctx.channel.request({ to }) rejects a cross-instance UserRef before local matching', () => {
    const env = install(channelDeclarations('rooms', PERMISSION));
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      {
        channel: {
          name: 'room-1',
          family: 'rooms',
          send: () => true,
          members: () => [env.member('peer')],
        },
      },
    );

    expect(() =>
      ctx.channel.request(
        'ask',
        { action: 'x' },
        { to: { __livething: 'user-ref', id: 'peer', instance: 'other' } },
      ),
    ).toThrow(/cross-instance-ref/);
    expect(env.sent).toHaveLength(0);
  });

  it('ctx.channel.request({ to: userRef }) asks a same-instance user member', async () => {
    const env = install(channelDeclarations('rooms', PERMISSION));
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      {
        channel: {
          name: 'room-1',
          family: 'rooms',
          send: () => true,
          members: () => [env.member('peer')],
        },
      },
    );

    const promise = ctx.channel.request(
      'ask',
      { action: 'x' },
      { to: { __livething: 'user-ref', id: 'peer', instance: undefined } },
    );

    expect(env.sent.map((entry) => entry.connectionId)).toEqual(['peer']);
    const { correlationId } = env.sent[0]!.opts;
    env.answerHook('peer', {
      event: 'ask',
      payload: { allowed: true },
      livething: { correlationId },
    });
    await expect(promise).resolves.toEqual({ allowed: true });
  });

  it('ctx.channel.request({ to: userRef }) never asks an anonymous member', async () => {
    vi.useFakeTimers();
    const env = install(channelDeclarations('rooms', PERMISSION));
    const anonymous = {
      id: 'conn_abc123',
      userId: '',
      tags: [],
      ref: env.member('conn_abc123').ref,
    };

    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      {
        channel: {
          name: 'room-1',
          family: 'rooms',
          send: () => true,
          members: () => [env.member('c1'), anonymous],
        },
      },
    );

    const promise = ctx.channel.request(
      'ask',
      { action: 'x' },
      {
        to: { __livething: 'user-ref', id: 'conn_abc123' },
        timeout: 1000,
      },
    );

    expect(env.sent).toHaveLength(0);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    vi.useRealTimers();
  });
});

const VOLUNTEER = new Map<string, ResolvedServerRequest>([
  ['volunteer', { responseValidator: v.object({ ready: v.boolean() }) }],
]);

describe('server→client broadcast request — first answer wins', () => {
  it('ctx.broadcastRequest resolves with the first valid answer and its from ref', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['c1', 'a', 'b', 'd'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 5 });

    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b', 'd']);
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: true },
      livething: { correlationId: legB.opts.correlationId },
    });

    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('ctx.user.request fans out to every socket the user holds and wins on the first answer', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { user: ['c1', 'u2'] });
    const promise = ctx.user.request('volunteer', { turn: 1 });

    // Fanned to all of the user's sockets — self is not excluded on a user handle.
    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['c1', 'u2']);
    const legU2 = env.sent.find((s) => s.connectionId === 'u2')!;
    env.answerHook('u2', {
      event: 'volunteer',
      payload: { ready: true },
      livething: { correlationId: legU2.opts.correlationId },
    });

    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'u2' }),
    });
  });

  it('ctx.users.get(id).request asks that user’s sockets and resolves the first answer', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { user: ['u2', 'u3'] });
    const promise = ctx.users.get('u').request('volunteer', { turn: 1 });

    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['u2', 'u3']);
    const legU3 = env.sent.find((s) => s.connectionId === 'u3')!;
    env.answerHook('u3', {
      event: 'volunteer',
      payload: { ready: true },
      livething: { correlationId: legU3.opts.correlationId },
    });

    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'u3' }),
    });
  });

  it('ctx.broadcastRequest on a bare-marker ack resolves a void response with the winner ref', async () => {
    const env = install(topDeclarations(new Map([['ping', {}]])));
    const ctx = env.buildCtx('c1', undefined, { connections: ['c1', 'a', 'b'] });
    const promise = ctx.broadcastRequest('ping', {});

    const legB = env.sent.find((s) => s.connectionId === 'b')!;
    env.answerHook('b', {
      event: 'ping',
      payload: { sneaky: true },
      livething: { correlationId: legB.opts.correlationId },
    });

    await expect(promise).resolves.toEqual({
      response: undefined,
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('ctx.broadcastRequest rejects undeclared events before sending any wire requests', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });

    await expect(ctx.broadcastRequest('missing', {})).rejects.toMatchObject({
      code: 'request-not-declared',
      detail: { event: 'missing' },
    });
    expect(env.sent).toHaveLength(0);
  });

  it('ignores an invalid answer and resolves on a later valid one', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 });

    const legA = env.sent.find((s) => s.connectionId === 'a')!;
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    const handledA = env.answerHook('a', {
      event: 'volunteer',
      payload: { ready: 'maybe' },
      livething: { correlationId: legA.opts.correlationId },
    });
    expect(handledA).toBe(true);

    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: false },
      livething: { correlationId: legB.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: false },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('drops a loser late answer after a winner already resolved', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 });
    const legA = env.sent.find((s) => s.connectionId === 'a')!;
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    env.answerHook('a', {
      event: 'volunteer',
      payload: { ready: true },
      livething: { correlationId: legA.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'a' }),
    });

    const handledLate = env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: false },
      livething: { correlationId: legB.opts.correlationId },
    });
    expect(handledLate).toBe(false);
  });

  it('rejects with timeout when nobody answers in time', async () => {
    vi.useFakeTimers();
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 }, { timeout: 1000 });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });

    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    vi.useRealTimers();
  });

  it('zero targets rejects with timeout', async () => {
    vi.useFakeTimers();
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['c1'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 }, { timeout: 1000 });
    expect(env.sent).toHaveLength(0);

    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    vi.useRealTimers();
  });

  it('one target disconnecting does not reject the broadcast', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 });
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    env.disconnectHook({ connection: { id: 'a' } });

    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: true },
      livething: { correlationId: legB.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('ctx.channel.broadcastRequest fans out to channel members with channel routing', async () => {
    const env = install(channelDeclarations('rooms', VOLUNTEER));
    env.live.add('a');
    env.live.add('b');
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      {
        channel: {
          name: 'room-1',
          family: 'rooms',
          send: () => true,
          members: () => [
            { id: 'a', ref: () => ({ __livething: 'connection-ref', id: 'a' }) },
            { id: 'b', ref: () => ({ __livething: 'connection-ref', id: 'b' }) },
          ],
        },
      },
    );
    const promise = ctx.channel.broadcastRequest('volunteer', { turn: 1 });

    expect(env.sent).toHaveLength(2);
    expect(env.sent[0]!.opts.channel).toBe('room-1');
    expect(env.sent[0]!.opts.channelFamily).toBe('rooms');
    const legA = env.sent.find((s) => s.connectionId === 'a')!;
    env.answerHook('a', {
      event: 'volunteer',
      payload: { ready: true },
      livething: { correlationId: legA.opts.correlationId },
    });

    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'a' }),
    });
  });

  it('ctx.channels.get(name).broadcastRequest fans out to a named channel', async () => {
    // ctx.channels.get(...) resolves the CHANNEL's own declaration, keyed by the channel
    // (here the static name 'lobby'), matching the active ctx.channel handle.
    const env = install(channelDeclarations('lobby', VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { channels: { lobby: ['a', 'b'] } });
    const promise = ctx.channels.get('lobby').broadcastRequest('volunteer', { turn: 1 });
    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b']);
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: false },
      livething: { correlationId: legB.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: false },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('ctx.channels.get(name).broadcastRequest rejects names missing from that channel declaration map', async () => {
    const env = install(channelDeclarations('lobby', VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { channels: { lobby: ['a', 'b'] } });

    await expect(ctx.channels.get('lobby').broadcastRequest('missing', {})).rejects.toMatchObject({
      code: 'request-not-declared',
      detail: { event: 'missing' },
    });
    expect(env.sent).toHaveLength(0);
  });

  it('ctx.tags group and ref broadcastRequest fan out to their members', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, {
      tags: { group: ['a', 'b'], refs: { admin: ['b'] } },
    });

    const groupPromise = ctx.tags.ephemeral('role').broadcastRequest('volunteer', { turn: 1 });
    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b']);
    const legA = env.sent.find((s) => s.connectionId === 'a')!;
    env.answerHook('a', {
      event: 'volunteer',
      payload: { ready: true },
      livething: { correlationId: legA.opts.correlationId },
    });
    await expect(groupPromise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'a' }),
    });

    env.sent.length = 0;
    const refPromise = ctx.tags
      .ephemeral('role')
      .ref('admin')
      .broadcastRequest('volunteer', { turn: 2 });
    expect(env.sent.map((s) => s.connectionId)).toEqual(['b']);
    const legB = env.sent[0]!;
    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: false },
      livething: { correlationId: legB.opts.correlationId },
    });

    await expect(refPromise).resolves.toEqual({
      response: { ready: false },
      from: expect.objectContaining({ id: 'b' }),
    });
  });
});

describe('server→client request — per-channel declaration isolation (Major 2)', () => {
  const askAllowed: ResolvedServerRequest = {
    responseValidator: v.object({ allowed: v.boolean() }),
  };

  const askCount: ResolvedServerRequest = {
    responseValidator: v.object({ count: v.number() }),
  };

  function roomsCtx(env: ReturnType<typeof install>) {
    return env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      { channel: { name: 'room-1', family: 'rooms', send: () => true } },
    );
  }

  it('two channels declaring the same event keep their own response schemas', async () => {
    const env = install(
      new Map([
        ...channelDeclarations('rooms', new Map([['ask', askAllowed]])),
        ...channelDeclarations('games', new Map([['ask', askCount]])),
      ]),
    );
    // rooms.ask validates { allowed }; a games-shaped answer is invalid for it.
    const ctx = roomsCtx(env);
    const promise = ctx.channel.request('ask', {});
    const { correlationId } = env.sent[0]!.opts;
    env.answerHook('c1', { event: 'ask', payload: { count: 5 }, livething: { correlationId } });
    await expect(promise).rejects.toMatchObject({ code: 'request-invalid-response' });
  });

  it('a channel event does not clobber the top-level event of the same name', async () => {
    const env = install(
      new Map([
        [serverRequestKey(null, 'ask'), askAllowed],
        ...channelDeclarations('rooms', new Map([['ask', askCount]])),
      ]),
    );
    // Top-level ctx.request resolves the top-level { allowed } schema.
    const topCtx = env.buildCtx('c1');
    const topPromise = topCtx.request('ask', {});
    const topId = env.sent[0]!.opts.correlationId;
    env.answerHook('c1', {
      event: 'ask',
      payload: { allowed: true },
      livething: { correlationId: topId },
    });
    await expect(topPromise).resolves.toEqual({ allowed: true });

    // The channel ctx.request resolves the channel's { count } schema instead.
    env.sent.length = 0;
    const chanCtx = roomsCtx(env);
    const chanPromise = chanCtx.channel.request('ask', {});
    const chanId = env.sent[0]!.opts.correlationId;
    env.answerHook('c1', {
      event: 'ask',
      payload: { count: 9 },
      livething: { correlationId: chanId },
    });

    await expect(chanPromise).resolves.toEqual({ count: 9 });
  });
});

describe('server→client request — only the asked connection may answer (Minor 3)', () => {
  it('ignores a targeted answer from a different connection', async () => {
    const env = install(topDeclarations(PERMISSION));
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'x' });
    const { correlationId } = env.sent[0]!.opts;

    let resolved = false;
    void promise.then(() => (resolved = true));

    // An attacker echoing the victim's correlationId is claimed but ignored.
    const handled = env.answerHook('attacker', {
      event: 'ask',
      payload: { allowed: true },
      livething: { correlationId },
    });
    expect(handled).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);

    // The real target can still answer.
    env.answerHook('c1', {
      event: 'ask',
      payload: { allowed: false },
      livething: { correlationId },
    });
    await expect(promise).resolves.toEqual({ allowed: false });
  });

  it('ignores a broadcast leg answer from a connection other than that leg target', async () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 });
    const legA = env.sent.find((s) => s.connectionId === 'a')!;

    // 'b' answering 'a's leg is ignored; the race stays open.
    const handled = env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: true },
      livething: { correlationId: legA.opts.correlationId },
    });
    expect(handled).toBe(true);

    const legB = env.sent.find((s) => s.connectionId === 'b')!;
    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: false },
      livething: { correlationId: legB.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: false },
      from: expect.objectContaining({ id: 'b' }),
    });
  });
});

describe('server→client broadcast request — self-exclusion (Major 6)', () => {
  function channelCtx(env: ReturnType<typeof install>) {
    env.live.add('a');
    env.live.add('b');
    return env.buildCtx(
      'c1',
      { channelName: 'room-1', channelFamily: 'rooms' },
      {
        channel: {
          name: 'room-1',
          family: 'rooms',
          send: () => true,
          members: () =>
            ['c1', 'a', 'b'].map((id) => ({
              id,
              ref: () => ({ __livething: 'connection-ref', id }),
            })),
        },
      },
    );
  }

  /** These tests read only what was sent. Nobody answers, so the request later times out. */
  function ignoreTimeout(request: Promise<unknown>): void {
    request.catch(() => {});
  }

  it('ctx.channel.broadcastRequest excludes the caller by default', () => {
    const env = install(channelDeclarations('rooms', VOLUNTEER));
    const ctx = channelCtx(env);
    ignoreTimeout(ctx.channel.broadcastRequest('volunteer', { turn: 1 }));
    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b']);
  });

  it('ctx.channel.broadcastRequest includes the caller with includeSelf: true', () => {
    const env = install(channelDeclarations('rooms', VOLUNTEER));
    const ctx = channelCtx(env);
    ignoreTimeout(ctx.channel.broadcastRequest('volunteer', { turn: 1 }, { includeSelf: true }));
    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b', 'c1']);
  });

  it('ctx.broadcastRequest includes the caller with includeSelf: true', () => {
    const env = install(topDeclarations(VOLUNTEER));
    const ctx = env.buildCtx('c1', undefined, { connections: ['c1', 'a', 'b'] });
    ignoreTimeout(ctx.broadcastRequest('volunteer', { turn: 1 }, { includeSelf: true }));
    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b', 'c1']);
  });
});

describe('server→client request — a payload the engine refuses to send', () => {
  it('leaves no timer behind when ctx.request rejects because sending threw', async () => {
    vi.useFakeTimers();
    try {
      let extender!: (ctx: any) => Record<string, unknown>;
      const engine = {
        generateId: (prefix?: string) => `${prefix}_1`,
        onAnswerFrame() {},
        onDisconnect() {},
        extendContext: (factory: any) => (extender = factory),
        sendServerRequest() {
          throw new Error('[livething] The payload for "ask" must be a plain object');
        },
      };

      makeServerRequestsPrimitive(topDeclarations(PERMISSION)).__setup!(engine as any);
      const ctx: any = {
        connection: { __livething: 'connection-ref', id: 'c1', instance: undefined, userId: 'i' },
        [ENGINE_CHANNEL_META]: {},
        connections: { get: () => ({ send: () => true }), all: () => [] },
      };

      Object.assign(ctx, extender(ctx));

      await expect(ctx.request('ask', 'not an object')).rejects.toThrow(/plain object/);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
