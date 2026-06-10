import { WSKitConfigError } from '@wskit/core';
import type { ClientEnvironment } from '~/environment.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `platform()`. */
export interface PlatformOptions {
  /** The platform environment — the source of visibility and network signals. */
  environment: ClientEnvironment;

  /**
   * Disconnect the socket after the app/tab has been hidden this many ms, then
   * reconnect when the user returns. Needs an environment with `onVisibilityChange`.
   */
  backgroundDisconnectMs?: number;
}

/**
 * Opt-in platform awareness. Nothing visibility- or network-aware runs unless
 * you add this primitive with an environment. It feeds the environment's
 * `online` signal to `reconnection({ networkAware })` and, when you set
 * `backgroundDisconnectMs`, drops the socket while the app is hidden and reopens
 * it on return.
 *
 * Platform code only loads when you register this primitive — it's not built in.
 */
export function platform(options: PlatformOptions): Primitive<EmptyTypeFn> {
  const { environment, backgroundDisconnectMs } = options;
  const wantsBackground = backgroundDisconnectMs !== undefined && backgroundDisconnectMs > 0;

  return {
    _tag: 'platform',
    setup(helpers) {
      // You asked for background disconnect but the environment can't see
      // visibility — surface the mistake now, not as a silent no-op.
      if (wantsBackground && !environment.onVisibilityChange) {
        throw new WSKitConfigError(
          '[wskit] platform({ backgroundDisconnectMs }) needs an environment that implements onVisibilityChange.',
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
      let reportingInitialVisibility = false;
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

        if (environment.onNetworkChange) {
          cleanups.push(
            environment.onNetworkChange((online) => {
              helpers.log.info(`network ${online ? 'online' : 'offline'}`);
              helpers.emitSignal('online', online);
            }),
          );
        }

        // Bind visibility whenever the environment can report it — the
        // `visibility` signal is a general extension point. The background
        // disconnect timer below is what's gated on `backgroundDisconnectMs`.
        if (environment.onVisibilityChange) {
          reportingInitialVisibility = true;
          cleanups.push(environment.onVisibilityChange(onVisibility));
          reportingInitialVisibility = false;
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

        // Only drop the socket while hidden if the app opted in.
        if (!wantsBackground) return;

        if (reportingInitialVisibility) return;

        hiddenTimer = setTimeout(() => {
          hiddenTimer = null;
          // If the socket already died on its own (e.g. a network blip) we have
          // nothing to drop. Don't mark it as our background drop — otherwise
          // foreground would reconnect a socket we never closed.
          if (helpers.getState() !== 'open') return;
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
          // Our own background drop keeps listening so it can reopen on return.
          if (selfDisconnecting) return;

          if (intentional) {
            // A real user disconnect() detaches the environment.
            backgrounded = false;
            unbind();
          } else {
            // An accidental drop: cancel the pending background countdown so it
            // can't fire on an already-dead socket and set a stale flag.
            clearHiddenTimer();
          }
        },
      };
    },
  };
}
