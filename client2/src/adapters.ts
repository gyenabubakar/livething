/**
 * Platform adapters for `@wskit/client`.
 *
 * Import from `@wskit/client/adapters`. Nothing visibility- or network-aware
 * runs unless you pass an adapter to the `platform()` primitive. Browsers use
 * the prebuilt `WebAdapter`; other runtimes author one with `adapter()`.
 */

/**
 * A platform adapter — the source of visibility and network signals for
 * `platform()`. An adapter declares what it supports by *implementing methods*:
 * there is no capabilities list. Implement `onVisibilityChange` to feed
 * `platform({ backgroundDisconnectMs })`; implement `onNetworkChange` to feed
 * `reconnection({ networkAware })`. Both are optional, and each takes a callback
 * and returns an unsubscribe.
 */
export interface ClientAdapter {
  /** Subscribe to app/tab visibility. `visible` is `true` when shown, `false` when hidden. */
  onVisibilityChange?(callback: (visible: boolean) => void): () => void;

  /** Subscribe to network reachability. `online` is `true` when online, `false` when offline. */
  onNetworkChange?(callback: (online: boolean) => void): () => void;
}

/**
 * Author a platform adapter for React Native, Electron, or any custom runtime.
 * Drop a method entirely to say "this platform can't supply that signal".
 *
 * ```ts
 * import { getCurrentWindow } from '@electron/remote';
 *
 * const ElectronAdapter = adapter({
 *   onVisibilityChange(cb) {
 *     const win = getCurrentWindow();
 *     const handler = () => cb(win.isFocused());
 *     win.on('focus', handler);
 *     win.on('blur', handler);
 *     return () => {
 *        win.off('focus', handler);
 *        win.off('blur', handler);
 *     };
 *   },
 * });
 * ```
 */
export function adapter(impl: ClientAdapter): ClientAdapter {
  return impl;
}

/**
 * The ready-made browser adapter. Reads `document.visibilitychange` for
 * visibility and `navigator.onLine` (plus the `online`/`offline` events) for
 * network. It is lazy and SSR-safe — globals are read inside the subscribe
 * calls, never at import time — and where those globals are absent (SSR, Node,
 * non-DOM runtimes) it simply provides no signals.
 */
export const WebAdapter = adapter({
  onVisibilityChange(callback) {
    if (typeof document === 'undefined') return () => undefined;

    function handler(): void {
      callback(document.visibilityState === 'visible');
    }

    document.addEventListener('visibilitychange', handler);

    return () => document.removeEventListener('visibilitychange', handler);
  },

  onNetworkChange(callback) {
    if (typeof window === 'undefined') return () => undefined;

    function onOnline(): void {
      callback(true);
    }

    function onOffline(): void {
      callback(false);
    }

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  },
});
