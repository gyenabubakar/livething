/* oxlint-disable @typescript-eslint/no-explicit-any */
import { RequestInvalidResponse } from '@wskit/core';
import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { makeServerRequestsPrimitive } from '~/request/outgoing-runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRef } from '~/context.ts';
import type { ResolvedServerRequest } from '~/request/capability.ts';

/**
 * Drive the install primitive against a fake `EngineAccess`, capturing the
 * hooks/extenders it registers so a test can simulate sends, answers, and
 * disconnects without a full engine.
 */
function install(decls: ReadonlyMap<string, ResolvedServerRequest>) {
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

  makeServerRequestsPrimitive(decls).__setup!(engine as any);

  /** A fake `ConnectionInfo` for one member — only the bits the runtime reads. */
  function member(id: string): any {
    return {
      id,
      ref: () => ({ __wskit: 'connection-ref', id, instance: undefined, identity: id }),
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
    },
  ): any {
    const ctx: any = {
      id: connectionId,
      self: { __wskit: 'connection-ref', id: connectionId, instance: undefined, identity: 'i' },
      [ENGINE_SCOPE_META]: scope ?? {},
      connection: (ref: ConnectionRef) => ({ send: () => true, __ref: ref }),
    };
    for (const id of [
      ...(opts?.connections ?? []),
      ...Object.values(opts?.channels ?? {}).flat(),
      ...(opts?.tags?.group ?? []),
      ...Object.values(opts?.tags?.refs ?? {}).flat(),
    ]) {
      live.add(id);
    }
    if (opts?.connections) {
      ctx.getConnections = () => opts.connections!.map(member);
    }
    if (opts?.channels) {
      ctx.channels = {
        get: (name: string) => ({
          name,
          scope: null,
          members: () => (opts.channels![name] ?? []).map(member),
        }),
      };
    }
    if (opts?.tags) {
      function makeGroup() {
        return {
          connections: () => (opts!.tags!.group ?? []).map(member),
          ref: (key: string) => ({
            connections: () => (opts!.tags!.refs?.[key] ?? []).map(member),
          }),
        };
      }
      ctx.tags = { ephemeral: makeGroup, persistent: makeGroup };
    }
    // The core attaches ctx.channel before contextExtenders run, so mirror that.
    if (opts?.channel) ctx.channel = opts.channel;
    Object.assign(ctx, extender(ctx));
    return ctx;
  }

  return { answerHook, disconnectHook, buildCtx, sent, live };
}

const PERMISSION = new Map<string, ResolvedServerRequest>([
  ['ask', { responseValidator: v.object({ allowed: v.boolean() }), broadcast: false }],
]);

describe('server→client request — outgoing runtime', () => {
  it('ctx.request resolves with the validated answer', async () => {
    const env = install(PERMISSION);
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'delete' });

    expect(env.sent).toHaveLength(1);
    const { correlationId } = env.sent[0]!.opts;
    expect(env.sent[0]!.opts.event).toBe('ask');

    const handled = env.answerHook('c1', {
      event: 'ask',
      payload: { allowed: true },
      wskit: { correlationId },
    });
    expect(handled).toBe(true);
    await expect(promise).resolves.toEqual({ allowed: true });
  });

  it('rejects with request-invalid-response when the answer fails its schema', async () => {
    const env = install(PERMISSION);
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'x' });
    const { correlationId } = env.sent[0]!.opts;

    env.answerHook('c1', { event: 'ask', payload: { allowed: 'nope' }, wskit: { correlationId } });
    await expect(promise).rejects.toSatisfy((e: unknown) => RequestInvalidResponse.matches(e));
  });

  it('rejects with timeout when no answer arrives', async () => {
    vi.useFakeTimers();
    const env = install(PERMISSION);
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'x' }, { timeout: 1000 });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    vi.useRealTimers();
  });

  it('rejects with disconnected when the target is not live', async () => {
    const env = install(PERMISSION);
    const ctx = env.buildCtx('c1');
    env.live.delete('c1');
    await expect(ctx.request('ask', { action: 'x' })).rejects.toMatchObject({
      code: 'disconnected',
    });
  });

  it('rejects pending requests for a connection that disconnects', async () => {
    const env = install(PERMISSION);
    const ctx = env.buildCtx('c1');
    const promise = ctx.request('ask', { action: 'x' });
    env.disconnectHook({ id: 'c1' });
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('ctx.connection(ref).request targets the addressed peer', async () => {
    const env = install(PERMISSION);
    const ctx = env.buildCtx('c1');
    const ref: ConnectionRef = {
      __wskit: 'connection-ref',
      id: 'peer',
      instance: undefined,
      identity: 'p',
    };
    const promise = ctx.connection(ref).request('ask', { action: 'x' });
    expect(env.sent[0]!.connectionId).toBe('peer');
    const { correlationId } = env.sent[0]!.opts;
    env.answerHook('peer', { event: 'ask', payload: { allowed: false }, wskit: { correlationId } });
    await expect(promise).resolves.toEqual({ allowed: false });
  });

  it('ctx.connection(ref).request to another instance throws cross-instance', () => {
    const env = install(PERMISSION);
    const ctx = env.buildCtx('c1');
    const ref: ConnectionRef = {
      __wskit: 'connection-ref',
      id: 'peer',
      instance: 'other',
      identity: 'p',
    };
    expect(() => ctx.connection(ref).request('ask', { action: 'x' })).toThrow(/cross-instance/);
  });

  it('ctx.channel.request stamps the channel routing', async () => {
    const env = install(PERMISSION);
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelScope: 'rooms' },
      { channel: { name: 'room-1', scope: 'rooms', send: () => true } },
    );
    const promise = ctx.channel.request('ask', { action: 'x' });
    expect(env.sent[0]!.opts.channel).toBe('room-1');
    expect(env.sent[0]!.opts.channelScope).toBe('rooms');
    const { correlationId } = env.sent[0]!.opts;
    env.answerHook('c1', { event: 'ask', payload: { allowed: true }, wskit: { correlationId } });
    await expect(promise).resolves.toEqual({ allowed: true });
  });

  it('a broadcast-declared event used via ctx.request rejects', async () => {
    const decls = new Map<string, ResolvedServerRequest>([
      ['volunteer', { responseValidator: undefined, broadcast: true }],
    ]);
    const env = install(decls);
    const ctx = env.buildCtx('c1');
    await expect(ctx.request('volunteer', { turn: 1 })).rejects.toThrow(/broadcastRequest/);
  });
});

const VOLUNTEER = new Map<string, ResolvedServerRequest>([
  ['volunteer', { responseValidator: v.object({ ready: v.boolean() }), broadcast: true }],
]);

describe('server→client broadcast request — first answer wins', () => {
  it('ctx.broadcastRequest resolves with the first valid answer and its from ref', async () => {
    const env = install(VOLUNTEER);
    const ctx = env.buildCtx('c1', undefined, { connections: ['c1', 'a', 'b', 'd'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 5 });

    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b', 'd']);
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: true },
      wskit: { correlationId: legB.opts.correlationId },
    });

    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('ignores an invalid answer and resolves on a later valid one', async () => {
    const env = install(VOLUNTEER);
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 });

    const legA = env.sent.find((s) => s.connectionId === 'a')!;
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    const handledA = env.answerHook('a', {
      event: 'volunteer',
      payload: { ready: 'maybe' },
      wskit: { correlationId: legA.opts.correlationId },
    });
    expect(handledA).toBe(true);

    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: false },
      wskit: { correlationId: legB.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: false },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('drops a loser late answer after a winner already resolved', async () => {
    const env = install(VOLUNTEER);
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 });
    const legA = env.sent.find((s) => s.connectionId === 'a')!;
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    env.answerHook('a', {
      event: 'volunteer',
      payload: { ready: true },
      wskit: { correlationId: legA.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'a' }),
    });

    const handledLate = env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: false },
      wskit: { correlationId: legB.opts.correlationId },
    });
    expect(handledLate).toBe(false);
  });

  it('rejects with timeout when nobody answers in time', async () => {
    vi.useFakeTimers();
    const env = install(VOLUNTEER);
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 }, { timeout: 1000 });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    vi.useRealTimers();
  });

  it('zero targets rejects with timeout', async () => {
    vi.useFakeTimers();
    const env = install(VOLUNTEER);
    const ctx = env.buildCtx('c1', undefined, { connections: ['c1'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 }, { timeout: 1000 });
    expect(env.sent).toHaveLength(0);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    vi.useRealTimers();
  });

  it('one target disconnecting does not reject the broadcast', async () => {
    const env = install(VOLUNTEER);
    const ctx = env.buildCtx('c1', undefined, { connections: ['a', 'b'] });
    const promise = ctx.broadcastRequest('volunteer', { turn: 1 });
    const legB = env.sent.find((s) => s.connectionId === 'b')!;

    env.disconnectHook({ id: 'a' });

    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: true },
      wskit: { correlationId: legB.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('ctx.channel.broadcastRequest fans out to channel members with channel routing', async () => {
    const env = install(VOLUNTEER);
    env.live.add('a');
    env.live.add('b');
    const ctx = env.buildCtx(
      'c1',
      { channelName: 'room-1', channelScope: 'rooms' },
      {
        channel: {
          name: 'room-1',
          scope: 'rooms',
          send: () => true,
          members: () => [
            { id: 'a', ref: () => ({ __wskit: 'connection-ref', id: 'a' }) },
            { id: 'b', ref: () => ({ __wskit: 'connection-ref', id: 'b' }) },
          ],
        },
      },
    );
    const promise = ctx.channel.broadcastRequest('volunteer', { turn: 1 });
    expect(env.sent).toHaveLength(2);
    expect(env.sent[0]!.opts.channel).toBe('room-1');
    expect(env.sent[0]!.opts.channelScope).toBe('rooms');
    const legA = env.sent.find((s) => s.connectionId === 'a')!;
    env.answerHook('a', {
      event: 'volunteer',
      payload: { ready: true },
      wskit: { correlationId: legA.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: true },
      from: expect.objectContaining({ id: 'a' }),
    });
  });

  it('ctx.channels.get(name).broadcastRequest fans out to a named channel', async () => {
    const env = install(VOLUNTEER);
    const ctx = env.buildCtx('c1', undefined, { channels: { lobby: ['a', 'b'] } });
    const promise = ctx.channels.get('lobby').broadcastRequest('volunteer', { turn: 1 });
    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b']);
    const legB = env.sent.find((s) => s.connectionId === 'b')!;
    env.answerHook('b', {
      event: 'volunteer',
      payload: { ready: false },
      wskit: { correlationId: legB.opts.correlationId },
    });
    await expect(promise).resolves.toEqual({
      response: { ready: false },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('ctx.tags group and ref broadcastRequest fan out to their members', async () => {
    const env = install(VOLUNTEER);
    const ctx = env.buildCtx('c1', undefined, {
      tags: { group: ['a', 'b'], refs: { admin: ['b'] } },
    });

    const groupPromise = ctx.tags.ephemeral('role').broadcastRequest('volunteer', { turn: 1 });
    expect(env.sent.map((s) => s.connectionId).sort()).toEqual(['a', 'b']);
    const legA = env.sent.find((s) => s.connectionId === 'a')!;
    env.answerHook('a', {
      event: 'volunteer',
      payload: { ready: true },
      wskit: { correlationId: legA.opts.correlationId },
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
      wskit: { correlationId: legB.opts.correlationId },
    });
    await expect(refPromise).resolves.toEqual({
      response: { ready: false },
      from: expect.objectContaining({ id: 'b' }),
    });
  });

  it('a non-broadcast event used via broadcastRequest rejects', async () => {
    const env = install(PERMISSION);
    const ctx = env.buildCtx('c1', undefined, { connections: ['a'] });
    await expect(ctx.broadcastRequest('ask', { action: 'x' })).rejects.toThrow(
      /not declared.*broadcast: true/,
    );
  });
});
