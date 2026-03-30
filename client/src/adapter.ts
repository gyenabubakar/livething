// ---------------------------------------------------------------------------
// Platform adapter — public API
// ---------------------------------------------------------------------------

export type VisibilityState = 'active' | 'inactive';
export type NetworkState = 'online' | 'offline';

/**
 * Base class for platform adapters. Extend this to provide visibility
 * and network detection for non-browser environments (React Native,
 * Electron, Capacitor, etc.).
 *
 * On the web, these are auto-detected — you don't need an adapter.
 * In SSR / Node, both methods are absent and features gracefully no-op.
 *
 * ```ts
 * class ElectronAdapter extends PlatformAdapter {
 *   override onVisibilityChange(callback) {
 *     const win = getCurrentWindow();
 *     const handler = () => callback(win.isFocused() ? 'active' : 'inactive');
 *     win.on('focus', handler);
 *     win.on('blur', handler);
 *     return () => { win.off('focus', handler); win.off('blur', handler); };
 *   }
 * }
 * ```
 */
export class PlatformAdapter {
  /**
   * Subscribe to app/tab visibility changes. Return an unsubscribe function.
   * Used by `inactiveTimeout` to disconnect when the app is backgrounded.
   */
  onVisibilityChange?(callback: (state: VisibilityState) => void): () => void;

  /**
   * Subscribe to network online/offline changes. Return an unsubscribe function.
   * Used by `networkAware` to pause reconnection when the device is offline.
   */
  onNetworkChange?(callback: (state: NetworkState) => void): () => void;
}
