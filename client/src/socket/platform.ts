import { PlatformAdapter } from '@/adapter.ts';
import type { NetworkState, VisibilityState } from '@/adapter.ts';
import type { SocketOptions } from '@/options.ts';

// ---------------------------------------------------------------------------
// Built-in web adapter (auto-detected)
// ---------------------------------------------------------------------------

class WebAdapter extends PlatformAdapter {
  override onVisibilityChange(callback: (state: VisibilityState) => void): () => void {
    function handler(): void {
      callback(document.visibilityState === 'visible' ? 'active' : 'inactive');
    }
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }

  override onNetworkChange(callback: (state: NetworkState) => void): () => void {
    function onOnline(): void {
      callback('online');
    }
    function onOffline(): void {
      callback('offline');
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }
}

/**
 * Lazy web platform detection. Returns a WebAdapter if browser globals
 * exist, `null` otherwise (SSR, Node, Web Workers).
 */
function detectWebAdapter(): PlatformAdapter | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  return new WebAdapter();
}

// ---------------------------------------------------------------------------
// Platform manager (internal)
// ---------------------------------------------------------------------------

/** Platform-relevant subset of SocketOptions. */
export type PlatformOptions = Pick<SocketOptions, 'adapter' | 'networkAware' | 'inactiveTimeout'>;

interface PlatformCallbacks {
  onNetworkOnline: () => void;
  onNetworkOffline: () => void;
  onActive: () => void;
  onInactive: () => void;
}

/**
 * Manages platform adapter subscriptions for network and visibility.
 * Resolves the adapter (user-provided → auto-detected web → null)
 * and handles bind/unbind lifecycle.
 *
 * Internal module — not exported from the package. Used by Socket.
 */
export class Platform {
  private readonly adapter: PlatformAdapter | null;
  private readonly networkAware: boolean;
  private readonly inactiveTimeout: number;
  private cleanups: (() => void)[] = [];

  constructor(options: PlatformOptions) {
    this.adapter = options.adapter ?? detectWebAdapter();
    this.networkAware = options.networkAware ?? true;
    this.inactiveTimeout = options.inactiveTimeout ?? 0;
  }

  /**
   * Subscribe to platform events. Call once when the socket starts
   * (first `connect()`). Callbacks fire for the lifetime of the socket
   * until `unbind()` is called.
   */
  bind(callbacks: PlatformCallbacks): void {
    this.unbind();

    if (this.networkAware && this.adapter?.onNetworkChange) {
      const unsub = this.adapter.onNetworkChange((state) => {
        if (state === 'online') callbacks.onNetworkOnline();
        else callbacks.onNetworkOffline();
      });
      this.cleanups.push(unsub);
    }

    if (this.inactiveTimeout > 0 && this.adapter?.onVisibilityChange) {
      const unsub = this.adapter.onVisibilityChange((state) => {
        if (state === 'active') callbacks.onActive();
        else callbacks.onInactive();
      });
      this.cleanups.push(unsub);
    }
  }

  /** Unsubscribe from all platform events. Call on `disconnect()`. */
  unbind(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }

  /** Whether network awareness is active (adapter supports it and option enabled). */
  get hasNetwork(): boolean {
    return this.networkAware && !!this.adapter?.onNetworkChange;
  }

  /** Whether visibility tracking is active (adapter supports it and timeout > 0). */
  get hasVisibility(): boolean {
    return this.inactiveTimeout > 0 && !!this.adapter?.onVisibilityChange;
  }
}
