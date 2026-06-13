/**
 * A platform environment — the source of visibility and network signals for
 * `platform()`. An environment declares what it supports by *implementing
 * methods*: there is no capabilities list. Implement `onVisibilityChange` to
 * feed `platform({ backgroundDisconnectMs })`; implement `onNetworkChange` to
 * feed `reconnection({ networkAware })`. Both are optional, and each takes a
 * callback and returns an unsubscribe.
 */
export interface ClientEnvironment {
  /** Subscribe to app/tab visibility. `visible` is `true` when shown, `false` when hidden. */
  onVisibilityChange?(callback: (visible: boolean) => void): () => void;

  /** Subscribe to network reachability. `online` is `true` when online, `false` when offline. */
  onNetworkChange?(callback: (online: boolean) => void): () => void;
}

/**
 * Author a platform environment for React Native, Electron, or any custom
 * runtime. Drop a method entirely to say "this platform can't supply that
 * signal".
 *
 * ```ts
 * import { getCurrentWindow } from '@electron/remote';
 *
 * const ElectronEnvironment = environment({
 *   onVisibilityChange(callback) {
 *     const currentWindow = getCurrentWindow();
 *     const handler = () => callback(currentWindow.isFocused());
 *     currentWindow.on('focus', handler);
 *     currentWindow.on('blur', handler);
 *     return () => {
 *        currentWindow.off('focus', handler);
 *        currentWindow.off('blur', handler);
 *     };
 *   },
 * });
 * ```
 */
export function environment(implementation: ClientEnvironment): ClientEnvironment {
  return implementation;
}

/**
 * The ready-made browser environment. Reads `document.visibilitychange` for
 * visibility and `navigator.onLine` (plus the `online`/`offline` events) for
 * network. It is lazy and SSR-safe — globals are read inside the subscribe
 * calls, never at import time — and where those globals are absent (SSR, Node,
 * non-DOM runtimes) it simply provides no signals.
 */
export const WebEnvironment = /* @__PURE__ */ environment({
  onVisibilityChange(callback) {
    if (typeof document === 'undefined') return () => undefined;

    function handler(): void {
      callback(document.visibilityState === 'visible');
    }

    document.addEventListener('visibilitychange', handler);
    handler(); // report the current state now, not just on the next change

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
    // Report the current state now, so a client that starts offline knows it,
    // instead of assuming online until the next change.
    callback(navigator.onLine);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  },
});
