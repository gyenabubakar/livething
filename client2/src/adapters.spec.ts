/* oxlint-disable @typescript-eslint/no-explicit-any -- test stubs for DOM globals */
import { adapter, WebAdapter } from '~/adapters.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('adapter()', () => {
  it('returns the implementation as-is — capability is method presence', () => {
    const a = adapter({
      onVisibilityChange() {
        return () => undefined;
      },
    });
    expect(typeof a.onVisibilityChange).toBe('function');
    expect(a.onNetworkChange).toBeUndefined();
  });
});

describe('WebAdapter — no DOM globals (SSR / Node)', () => {
  it('provides no signals and never throws', () => {
    const visCb = vi.fn();
    const netCb = vi.fn();
    const unsubVis = WebAdapter.onVisibilityChange!(visCb);
    const unsubNet = WebAdapter.onNetworkChange!(netCb);

    expect(typeof unsubVis).toBe('function');
    expect(typeof unsubNet).toBe('function');
    expect(visCb).not.toHaveBeenCalled();
    expect(netCb).not.toHaveBeenCalled();

    expect(() => {
      unsubVis();
      unsubNet();
    }).not.toThrow();
  });
});

describe('WebAdapter — with DOM globals', () => {
  function stubDom() {
    const listeners: Record<string, ((e?: unknown) => void)[]> = {};
    const state = { visibility: 'visible' as 'visible' | 'hidden' };
    const target = {
      addEventListener(type: string, h: () => void) {
        (listeners[type] ??= []).push(h);
      },
      removeEventListener(type: string, h: () => void) {
        listeners[type] = (listeners[type] ?? []).filter((x) => x !== h);
      },
    };
    (globalThis as any).document = {
      get visibilityState() {
        return state.visibility;
      },
      addEventListener: target.addEventListener,
      removeEventListener: target.removeEventListener,
    };
    (globalThis as any).window = target;
    return {
      listeners,
      fire(type: string) {
        for (const h of listeners[type] ?? []) h();
      },
      setVisibility(v: 'visible' | 'hidden') {
        state.visibility = v;
      },
      restore() {
        delete (globalThis as any).document;
        delete (globalThis as any).window;
      },
    };
  }

  let dom: ReturnType<typeof stubDom>;
  afterEach(() => dom.restore());

  it('onVisibilityChange reads document.visibilitychange', () => {
    dom = stubDom();
    const cb = vi.fn();
    const unsub = WebAdapter.onVisibilityChange!(cb);

    dom.setVisibility('hidden');
    dom.fire('visibilitychange');
    expect(cb).toHaveBeenLastCalledWith(false);

    dom.setVisibility('visible');
    dom.fire('visibilitychange');
    expect(cb).toHaveBeenLastCalledWith(true);

    unsub();
    dom.fire('visibilitychange');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('onNetworkChange uses the online / offline events', () => {
    dom = stubDom();
    const cb = vi.fn();
    const unsub = WebAdapter.onNetworkChange!(cb);

    dom.fire('offline');
    expect(cb).toHaveBeenLastCalledWith(false);

    dom.fire('online');
    expect(cb).toHaveBeenLastCalledWith(true);

    unsub();
    dom.fire('offline');
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
