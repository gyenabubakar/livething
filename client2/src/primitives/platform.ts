import { WSKitConfigError } from '@wskit/core';
import type { ClientAdapter } from '~/adapters.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `platform()`. */
export interface PlatformOptions {
  /** The platform adapter — the source of visibility and network signals. */
  adapter: ClientAdapter;

  /**
   * Disconnect the socket after the app/tab has been hidden this many ms, then
   * reconnect when the user returns. Needs an adapter with `onVisibilityChange`.
   */
  backgroundDisconnectMs?: number;
}

/**
 * Opt-in platform awareness. Nothing visibility- or network-aware runs unless
 * you add this primitive with an adapter. It feeds the adapter's `online` signal
 * to `reconnection({ networkAware })` and, when you set `backgroundDisconnectMs`,
 * drops the socket while the app is hidden and reopens it on return.
 *
 * The kernel stays free of any platform code — this primitive only ships when
 * you register it.
 */
export function platform(options: PlatformOptions): Primitive<EmptyTypeFn> {
  const { adapter, backgroundDisconnectMs } = options;
  const wantsBackground = backgroundDisconnectMs !== undefined && backgroundDisconnectMs > 0;

  return {
    _tag: 'platform',
    setup(helpers) {
      // You asked for background disconnect but the adapter can't see visibility —
      // surface the mistake now, not as a silent no-op.
      if (wantsBackground && !adapter.onVisibilityChange) {
        throw new WSKitConfigError(
          '[wskit] platform({ backgroundDisconnectMs }) needs an adapter that implements onVisibilityChange.',
        );
      }

      const cleanups: (() => void)[] = [];

      let bound = false;
      // True while the socket is closed because *we* dropped it for being hidden,
      // so we know to reopen it when the app comes back.
      let backgrounded = false;

      // True only during our own disconnect() call, so onClose can tell a
      // background drop apart from a real user disconnect().
      let selfDisconnecting = false;
      let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

      function clearHiddenTimer(): void {
        if (hiddenTimer !== null) {
          clearTimeout(hiddenTimer);
          hiddenTimer = null;
        }
      }

      function bind(): void {
        if (bound) return;
        bound = true;

        if (adapter.onNetworkChange) {
          cleanups.push(
            adapter.onNetworkChange((online) => {
              helpers.log.info(`network ${online ? 'online' : 'offline'}`);
              helpers.emitSignal('online', online);
            }),
          );
        }

        if (wantsBackground && adapter.onVisibilityChange) {
          cleanups.push(adapter.onVisibilityChange(onVisibility));
        }
      }

      function onVisibility(visible: boolean): void {
        helpers.log.info(`visibility ${visible ? 'visible' : 'hidden'}`);
        helpers.emitSignal('visibility', visible);
        clearHiddenTimer();

        if (visible) {
          if (backgrounded) {
            backgrounded = false;
            helpers.log.info('foreground — reconnecting');
            helpers.connect();
          }
          return;
        }

        hiddenTimer = setTimeout(() => {
          hiddenTimer = null;
          backgrounded = true;
          selfDisconnecting = true;
          helpers.log.info(`hidden ${backgroundDisconnectMs}ms — disconnecting`);
          helpers.disconnect();
          selfDisconnecting = false;
        }, backgroundDisconnectMs);
      }

      function unbind(): void {
        clearHiddenTimer();
        for (const cleanup of cleanups) cleanup();
        cleanups.length = 0;
        bound = false;
      }

      return {
        id: 'platform',
        onOpen() {
          bind();
          return null;
        },
        onClose(_code, _reason, intentional) {
          // Only a real user disconnect() detaches the adapter. Our own
          // background drop keeps listening so it can reopen on return.
          if (intentional && !selfDisconnecting) {
            backgrounded = false;
            unbind();
          }
        },
      };
    },
  };
}
