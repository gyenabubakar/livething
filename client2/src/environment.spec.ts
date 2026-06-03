/* oxlint-disable @typescript-eslint/no-explicit-any -- test stubs for DOM globals */
import { environment, WebEnvironment } from '~/environment.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('environment()', () => {
  it('returns the implementation as-is — capability is method presence', () => {
    const built = environment({
      onVisibilityChange() {
        return () => undefined;
      },
    });
    expect(typeof built.onVisibilityChange).toBe('function');
    expect(built.onNetworkChange).toBeUndefined();
  });
});

describe('WebEnvironment — no DOM globals (SSR / Node)', () => {
  it('provides no signals and never throws', () => {
    const visibilityCallback = vi.fn();
    const networkCallback = vi.fn();
    const unsubscribeVisibility = WebEnvironment.onVisibilityChange!(visibilityCallback);
    const unsubscribeNetwork = WebEnvironment.onNetworkChange!(networkCallback);

    expect(typeof unsubscribeVisibility).toBe('function');
    expect(typeof unsubscribeNetwork).toBe('function');
    expect(visibilityCallback).not.toHaveBeenCalled();
    expect(networkCallback).not.toHaveBeenCalled();

    expect(() => {
      unsubscribeVisibility();
      unsubscribeNetwork();
    }).not.toThrow();
  });
});

describe('WebEnvironment — with DOM globals', () => {
  function stubDom() {
    const listeners: Record<string, ((e?: unknown) => void)[]> = {};
    const state = { visibility: 'visible' as 'visible' | 'hidden' };
    const target = {
      addEventListener(type: string, handler: () => void) {
        (listeners[type] ??= []).push(handler);
      },
      removeEventListener(type: string, handler: () => void) {
        listeners[type] = (listeners[type] ?? []).filter((registered) => registered !== handler);
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
        for (const handler of listeners[type] ?? []) handler();
      },
      setVisibility(visibility: 'visible' | 'hidden') {
        state.visibility = visibility;
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
    const callback = vi.fn();
    const unsubscribe = WebEnvironment.onVisibilityChange!(callback);

    dom.setVisibility('hidden');
    dom.fire('visibilitychange');
    expect(callback).toHaveBeenLastCalledWith(false);

    dom.setVisibility('visible');
    dom.fire('visibilitychange');
    expect(callback).toHaveBeenLastCalledWith(true);

    unsubscribe();
    dom.fire('visibilitychange');
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('onNetworkChange uses the online / offline events', () => {
    dom = stubDom();
    const callback = vi.fn();
    const unsubscribe = WebEnvironment.onNetworkChange!(callback);

    dom.fire('offline');
    expect(callback).toHaveBeenLastCalledWith(false);

    dom.fire('online');
    expect(callback).toHaveBeenLastCalledWith(true);

    unsubscribe();
    dom.fire('offline');
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
