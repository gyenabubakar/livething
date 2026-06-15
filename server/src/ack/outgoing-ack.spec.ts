/* oxlint-disable @typescript-eslint/no-explicit-any */
import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { makeOutgoingAckPrimitive } from '~/ack/outgoing-runtime.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionRef } from '~/context.ts';

/**
 * Drive the outgoing-ack install primitive against a fake `EngineAccess`,
 * capturing the hooks/extenders it registers so a test can simulate sends,
 * client `__ack__` confirmations, and disconnects without a full engine.
 */
function install(defaultTimeoutMs?: number) {
  let ackHook!: (connectionId: string, ackId: string) => boolean;
  let disconnectHook!: (ctx: any) => void;
  let extender!: (ctx: any) => Record<string, unknown>;
  let idCounter = 0;
  const sent: Array<{ connectionId: string; opts: any }> = [];
  const live = new Set<string>(['c1', 'peer']);

  const engine = {
    generateId: (prefix?: string) => `${prefix}_${(idCounter += 1)}`,
    onAckFrame: (h: any) => (ackHook = h),
    onDisconnect: (h: any) => (disconnectHook = h),
    extendContext: (factory: any) => (extender = factory),
    sendServerWithAck: (connectionId: string, opts: any) => {
      sent.push({ connectionId, opts });
      return live.has(connectionId);
    },
  };

  makeOutgoingAckPrimitive(defaultTimeoutMs).__setup!(engine as any);

  function buildCtx(connectionId: string | undefined, scope?: any, channel?: any): any {
    const ctx: any = {
      id: connectionId,
      self: { __wskit: 'connection-ref', id: connectionId, instance: undefined, identity: 'i' },
      [ENGINE_SCOPE_META]: scope ?? {},
      connection: (ref: ConnectionRef) => ({ send: () => true, __ref: ref }),
    };
    if (channel) ctx.channel = channel;
    Object.assign(ctx, extender(ctx));
    return ctx;
  }

  return { ackHook, disconnectHook, buildCtx, sent, live };
}

describe('server→client ack — outgoing runtime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ctx.sendWithAck resolves on the client __ack__ receipt', async () => {
    const env = install();
    const ctx = env.buildCtx('c1');
    const promise = ctx.sendWithAck('settings', { theme: 'dark' });

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]!.opts.event).toBe('settings');
    const { ackId } = env.sent[0]!.opts;

    const handled = env.ackHook('c1', ackId);
    expect(handled).toBe(true);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects with timeout when no __ack__ arrives in time', async () => {
    const env = install();
    const ctx = env.buildCtx('c1');
    const promise = ctx.sendWithAck('settings', { theme: 'dark' });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });

    vi.advanceTimersByTime(10_000);
    await rejection;
  });

  it('rejects with disconnected when the target connection drops while waiting', async () => {
    const env = install();
    const ctx = env.buildCtx('c1');
    const promise = ctx.sendWithAck('settings', { theme: 'dark' });

    env.disconnectHook({ id: 'c1' });
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects with disconnected immediately when the socket is already gone', async () => {
    const env = install();
    env.live.delete('c1');
    const ctx = env.buildCtx('c1');
    await expect(ctx.sendWithAck('settings', { theme: 'dark' })).rejects.toMatchObject({
      code: 'disconnected',
    });
  });

  it('ctx.connection(ref).sendWithAck targets the named peer', async () => {
    const env = install();
    const ctx = env.buildCtx('c1');
    const ref = { __wskit: 'connection-ref', id: 'peer', instance: undefined, identity: 'p' };
    const promise = ctx.connection(ref).sendWithAck('settings', { theme: 'dark' });

    expect(env.sent[0]!.connectionId).toBe('peer');
    env.ackHook('peer', env.sent[0]!.opts.ackId);
    await expect(promise).resolves.toBeUndefined();
  });

  it('ctx.channel.sendWithAck stamps the channel scope on the outgoing frame', async () => {
    const env = install();
    const channel = { name: 'lobby', scope: null };
    const ctx = env.buildCtx('c1', { channelName: 'lobby', channelScope: null }, channel);
    const promise = ctx.channel.sendWithAck('settings', { theme: 'dark' });

    expect(env.sent[0]!.opts.channel).toBe('lobby');
    env.ackHook('c1', env.sent[0]!.opts.ackId);
    await expect(promise).resolves.toBeUndefined();
  });

  describe('timeout precedence', () => {
    it('a per-send timeout overrides the ack({ timeout }) default', async () => {
      const env = install(5_000);
      const ctx = env.buildCtx('c1');
      const promise = ctx.sendWithAck('settings', { theme: 'dark' }, { timeout: 1_000 });
      const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });

      // Fires at the per-send 1s, well before the 5s capability default.
      vi.advanceTimersByTime(1_000);
      await rejection;
    });

    it('the ack({ timeout }) default applies when no per-send timeout is given', async () => {
      const env = install(2_000);
      const ctx = env.buildCtx('c1');
      const promise = ctx.sendWithAck('settings', { theme: 'dark' });
      const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });

      vi.advanceTimersByTime(1_999);
      // Not yet timed out at 1999ms — a late ack would still resolve.
      vi.advanceTimersByTime(1);
      await rejection;
    });

    it('the built-in 10s applies when neither per-send nor ack({ timeout }) is set', async () => {
      const env = install();
      const ctx = env.buildCtx('c1');
      const promise = ctx.sendWithAck('settings', { theme: 'dark' });
      const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });

      vi.advanceTimersByTime(9_999);
      vi.advanceTimersByTime(1);
      await rejection;
    });
  });

  it('a duplicate __ack__ after the first is settled finds no pending entry', async () => {
    const env = install();
    const ctx = env.buildCtx('c1');
    const promise = ctx.sendWithAck('settings', { theme: 'dark' });
    const { ackId } = env.sent[0]!.opts;

    expect(env.ackHook('c1', ackId)).toBe(true);
    await expect(promise).resolves.toBeUndefined();
    expect(env.ackHook('c1', ackId)).toBe(false);
  });
});
