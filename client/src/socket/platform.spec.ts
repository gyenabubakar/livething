import { PlatformAdapter } from '~/adapter.ts';
import { Platform } from '~/socket/platform.ts';
import { describe, expect, it, vi } from 'vitest';
import type { NetworkState, VisibilityState } from '~/adapter.ts';
import type { PlatformOptions } from '~/socket/platform.ts';

function createMockAdapter(options: { visibility?: boolean; network?: boolean } = {}) {
  const adapter = new PlatformAdapter();
  const listeners: {
    visibility: ((state: VisibilityState) => void)[];
    network: ((state: NetworkState) => void)[];
  } = { visibility: [], network: [] };

  if (options.visibility !== false) {
    adapter.onVisibilityChange = vi.fn((callback: (state: VisibilityState) => void) => {
      listeners.visibility.push(callback);
      return () => {
        const idx = listeners.visibility.indexOf(callback);
        if (idx >= 0) listeners.visibility.splice(idx, 1);
      };
    });
  }

  if (options.network !== false) {
    adapter.onNetworkChange = vi.fn((callback: (state: NetworkState) => void) => {
      listeners.network.push(callback);
      return () => {
        const idx = listeners.network.indexOf(callback);
        if (idx >= 0) listeners.network.splice(idx, 1);
      };
    });
  }

  return {
    adapter,
    emit: {
      visibility: (state: VisibilityState) => listeners.visibility.forEach((cb) => cb(state)),
      network: (state: NetworkState) => listeners.network.forEach((cb) => cb(state)),
    },
    listeners,
  };
}

function createPlatform(
  overrides: Partial<PlatformOptions> = {},
  adapterOptions?: { visibility?: boolean; network?: boolean },
) {
  const mock = createMockAdapter(adapterOptions);
  const opts: PlatformOptions = {
    adapter: mock.adapter,
    ...overrides,
  };
  const platform = new Platform(opts);
  return { platform, mock };
}

function createCallbacks() {
  return {
    onNetworkOnline: vi.fn(),
    onNetworkOffline: vi.fn(),
    onActive: vi.fn(),
    onInactive: vi.fn(),
  };
}

describe('PlatformAdapter', () => {
  it('has no methods by default', () => {
    const adapter = new PlatformAdapter();
    expect(adapter.onVisibilityChange).toBeUndefined();
    expect(adapter.onNetworkChange).toBeUndefined();
  });
});

describe('Platform', () => {
  // ── Constructor / adapter resolution ──────────────────────

  it('uses user-provided adapter', () => {
    const { platform } = createPlatform({ networkAware: true, inactiveTimeout: 1000 });
    expect(platform.hasNetwork).toBe(true);
    expect(platform.hasVisibility).toBe(true);
  });

  it('falls back to web detection when no adapter provided', () => {
    // In Node/vitest, document/window are undefined → no web adapter
    const platform = new Platform({});
    expect(platform.hasNetwork).toBe(false);
    expect(platform.hasVisibility).toBe(false);
  });

  // ── hasNetwork / hasVisibility ────────────────────────────

  it('hasNetwork is false when networkAware is false', () => {
    const { platform } = createPlatform({ networkAware: false });
    expect(platform.hasNetwork).toBe(false);
  });

  it('hasNetwork is false when adapter lacks onNetworkChange', () => {
    const { platform } = createPlatform({ networkAware: true }, { network: false });
    expect(platform.hasNetwork).toBe(false);
  });

  it('hasVisibility is false when inactiveTimeout is 0', () => {
    const { platform } = createPlatform({ inactiveTimeout: 0 });
    expect(platform.hasVisibility).toBe(false);
  });

  it('hasVisibility is false when adapter lacks onVisibilityChange', () => {
    const { platform } = createPlatform({ inactiveTimeout: 5000 }, { visibility: false });
    expect(platform.hasVisibility).toBe(false);
  });

  // ── Network callbacks ─────────────────────────────────────

  it('fires onNetworkOnline when adapter reports online', () => {
    const { platform, mock } = createPlatform({ networkAware: true });
    const callbacks = createCallbacks();
    platform.bind(callbacks);

    mock.emit.network('online');
    expect(callbacks.onNetworkOnline).toHaveBeenCalledTimes(1);
    expect(callbacks.onNetworkOffline).not.toHaveBeenCalled();

    platform.unbind();
  });

  it('fires onNetworkOffline when adapter reports offline', () => {
    const { platform, mock } = createPlatform({ networkAware: true });
    const callbacks = createCallbacks();
    platform.bind(callbacks);

    mock.emit.network('offline');
    expect(callbacks.onNetworkOffline).toHaveBeenCalledTimes(1);
    expect(callbacks.onNetworkOnline).not.toHaveBeenCalled();

    platform.unbind();
  });

  it('does not subscribe to network when networkAware is false', () => {
    const { platform, mock } = createPlatform({ networkAware: false });
    const callbacks = createCallbacks();
    platform.bind(callbacks);

    expect(mock.adapter.onNetworkChange).not.toHaveBeenCalled();

    platform.unbind();
  });

  // ── Visibility callbacks ──────────────────────────────────

  it('fires onActive when adapter reports active', () => {
    const { platform, mock } = createPlatform({ inactiveTimeout: 5000 });
    const callbacks = createCallbacks();
    platform.bind(callbacks);

    mock.emit.visibility('active');
    expect(callbacks.onActive).toHaveBeenCalledTimes(1);
    expect(callbacks.onInactive).not.toHaveBeenCalled();

    platform.unbind();
  });

  it('fires onInactive when adapter reports inactive', () => {
    const { platform, mock } = createPlatform({ inactiveTimeout: 5000 });
    const callbacks = createCallbacks();
    platform.bind(callbacks);

    mock.emit.visibility('inactive');
    expect(callbacks.onInactive).toHaveBeenCalledTimes(1);
    expect(callbacks.onActive).not.toHaveBeenCalled();

    platform.unbind();
  });

  it('does not subscribe to visibility when inactiveTimeout is 0', () => {
    const { platform, mock } = createPlatform({ inactiveTimeout: 0 });
    const callbacks = createCallbacks();
    platform.bind(callbacks);

    expect(mock.adapter.onVisibilityChange).not.toHaveBeenCalled();

    platform.unbind();
  });

  // ── Bind / Unbind ─────────────────────────────────────────

  it('unbind removes all listeners', () => {
    const { platform, mock } = createPlatform({
      networkAware: true,
      inactiveTimeout: 5000,
    });
    const callbacks = createCallbacks();
    platform.bind(callbacks);

    expect(mock.listeners.network.length).toBe(1);
    expect(mock.listeners.visibility.length).toBe(1);

    platform.unbind();

    expect(mock.listeners.network.length).toBe(0);
    expect(mock.listeners.visibility.length).toBe(0);
  });

  it('callbacks do not fire after unbind', () => {
    const { platform, mock } = createPlatform({
      networkAware: true,
      inactiveTimeout: 5000,
    });
    const callbacks = createCallbacks();
    platform.bind(callbacks);
    platform.unbind();

    // Emitting after unbind should have no effect (listeners removed)
    mock.emit.network('online');
    mock.emit.visibility('active');

    expect(callbacks.onNetworkOnline).not.toHaveBeenCalled();
    expect(callbacks.onActive).not.toHaveBeenCalled();
  });

  it('bind is idempotent — rebinding cleans up previous listeners', () => {
    const { platform, mock } = createPlatform({
      networkAware: true,
      inactiveTimeout: 5000,
    });
    const callbacks1 = createCallbacks();
    const callbacks2 = createCallbacks();

    platform.bind(callbacks1);
    platform.bind(callbacks2);

    // Only one set of listeners should be active
    expect(mock.listeners.network.length).toBe(1);
    expect(mock.listeners.visibility.length).toBe(1);

    mock.emit.network('online');
    expect(callbacks1.onNetworkOnline).not.toHaveBeenCalled();
    expect(callbacks2.onNetworkOnline).toHaveBeenCalledTimes(1);

    platform.unbind();
  });

  it('unbind when not bound is a no-op', () => {
    const { platform } = createPlatform();
    // Should not throw
    platform.unbind();
    platform.unbind();
  });
});

describe('WebAdapter auto-detection', () => {
  it('returns null in non-browser environment (no document/window)', () => {
    // In vitest/Node, document and window are not defined
    const platform = new Platform({});
    expect(platform.hasNetwork).toBe(false);
    expect(platform.hasVisibility).toBe(false);
  });

  it('user adapter takes precedence over auto-detection', () => {
    const mock = createMockAdapter();
    const platform = new Platform({
      adapter: mock.adapter,
      networkAware: true,
      inactiveTimeout: 1000,
    });
    expect(platform.hasNetwork).toBe(true);
    expect(platform.hasVisibility).toBe(true);
  });
});
