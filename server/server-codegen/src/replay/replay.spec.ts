import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { dedup } from '~/dedup/dedup.ts';
import { replay } from '~/replay/replay.ts';
import { sequence } from '~/sequence/sequence.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';

describe('replay', () => {
  it('produces correct tag and kind', () => {
    const p = replay();
    expect(p.__wskit).toBe('replay');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = replay();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(replay.__key);
  });

  it('declares dependencies and requires', () => {
    const p = replay();
    expect(p.__dependencies).toEqual([sequence, dedup]);
    expect(p.__requires).toEqual({ storage: true });
  });

  it('stores the onReplay handler when provided', () => {
    async function handler() {}
    const p = replay({ onReplay: handler });
    expect(p.onReplay).toBe(handler);
  });

  it('adds top-level sendReplay through a context extender', () => {
    const extenders: Array<NonNullable<Parameters<EngineAccess['extendContext']>[0]>> = [];
    const engine = {
      getScopeInfo() {
        return {};
      },
      extendContext(factory) {
        extenders.push(factory);
      },
      sendReplay() {},
      onReplayRequest() {},
    } as Pick<
      EngineAccess,
      'extendContext' | 'getScopeInfo' | 'onReplayRequest' | 'sendReplay'
    > as EngineAccess;

    replay().__setup?.(engine);

    const ctx: Record<PropertyKey, unknown> = {
      id: 'c1',
      [ENGINE_SCOPE_META]: {},
    };

    extenders[0]!(ctx);

    expect(typeof ctx.sendReplay).toBe('function');
  });

  it('adds channel sendReplay only for the matching channel scope', () => {
    const extenders: Array<NonNullable<Parameters<EngineAccess['extendContext']>[0]>> = [];
    const engine = {
      getScopeInfo() {
        return { channelKey: 'rooms' };
      },
      extendContext(factory) {
        extenders.push(factory);
      },
      sendReplay() {},
      onReplayRequest() {},
    } as Pick<
      EngineAccess,
      'extendContext' | 'getScopeInfo' | 'onReplayRequest' | 'sendReplay'
    > as EngineAccess;

    replay().__setup?.(engine);

    const matchingCtx: Record<PropertyKey, unknown> = {
      id: 'c1',
      channel: { name: 'room-1' },
      [ENGINE_SCOPE_META]: {
        channelName: 'room-1',
        channelScope: 'rooms',
      },
    };
    const otherCtx: Record<PropertyKey, unknown> = {
      id: 'c2',
      channel: { name: 'other' },
      [ENGINE_SCOPE_META]: {
        channelName: 'other',
        channelScope: 'other-scope',
      },
    };

    extenders[0]!(matchingCtx);
    extenders[0]!(otherCtx);

    expect(typeof (matchingCtx.channel as { sendReplay?: unknown }).sendReplay).toBe('function');
    expect((otherCtx.channel as { sendReplay?: unknown }).sendReplay).toBeUndefined();
  });

  it('handles only matching replay requests', async () => {
    const replayRequests: Array<NonNullable<Parameters<EngineAccess['onReplayRequest']>[0]>> = [];
    const seen: number[] = [];
    const engine = {
      getScopeInfo() {
        return { channelKey: 'rooms' };
      },
      extendContext() {},
      sendReplay() {},
      onReplayRequest(handler) {
        replayRequests.push(handler);
      },
    } as Pick<
      EngineAccess,
      'extendContext' | 'getScopeInfo' | 'onReplayRequest' | 'sendReplay'
    > as EngineAccess;

    replay({
      async onReplay(_ctx, since) {
        seen.push(since);
      },
    }).__setup?.(engine);

    const handler = replayRequests[0]!;

    expect(await handler({}, 4, { channelName: 'room-1', channelScope: 'rooms' })).toBe(true);
    expect(await handler({}, 9, {})).toBe(false);
    expect(seen).toEqual([4]);
  });
});
