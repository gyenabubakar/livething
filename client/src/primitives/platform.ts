import { LiveThingConfigError } from '@livething/core';
import { dispatchToHandlers } from '~/internal/dispatch.ts';
import { signalBus } from '~/internal/signals.ts';
import { createStore } from '~/internal/store.ts';
import type { ClientEnvironment } from '~/environment.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { Primitive, TypeFn } from '~/primitives/types.ts';

/** The network-status store that `platform()` adds to the socket. */
export interface PlatformApi {
  /**
   * Whether the device is online, as a reactive store: `online.get()` reads it
   * now and `online.subscribe(listener)` watches it. It only changes when the
   * environment reports network changes (via `onNetworkChange`); with an
   * environment that can't, it stays `true`.
   */
  online: ReadableStore<boolean>;
}

interface PlatformTypeFn extends TypeFn {
  readonly _api: PlatformApi;
}

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
export function platform(options: PlatformOptions): Primitive<PlatformTypeFn> {
  const { environment, backgroundDisconnectMs } = options;
  const wantsBackground = backgroundDisconnectMs !== undefined && backgroundDisconnectMs > 0;

  return {
    _tag: 'platform',
    setup(helpers) {
      const signals = signalBus(helpers);
      const onlineStore = createStore<boolean>(true, (error) => helpers.log.report(error));

      // You asked for background disconnect but the environment can't see
      // visibility — surface the mistake now, not as a silent no-op.
      if (wantsBackground && !environment.onVisibilityChange) {
        throw new LiveThingConfigError(
          'platform({ backgroundDisconnectMs }) needs an environment that implements onVisibilityChange.',
        );
      }

      const cleanups: (() => void)[] = [];

      let bound = false;
      // True while the socket is closed because *we* dropped it for being hidden,
      // so we know to reopen it when the app comes back.
      let backgrounded = false;

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
              onlineStore.set(online);
              signals.emit('online', online);
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
        signals.emit('visibility', visible);
        clearHiddenTimer();

        if (visible) {
          if (backgrounded) {
            backgrounded = false;
            helpers.log.info('foreground — reconnecting');
            helpers.resume();
          }

          return;
        }

        if (!wantsBackground) return;

        if (reportingInitialVisibility) return;

        hiddenTimer = setTimeout(() => {
          hiddenTimer = null;
          // If the socket already died on its own (e.g. a network blip) we have
          // nothing to drop. Don't mark it as our background drop — otherwise
          // foreground would reconnect a socket we never closed.
          if (helpers.getState() !== 'open') return;

          backgrounded = true;
          helpers.log.info(`hidden ${backgroundDisconnectMs}ms — disconnecting`);
          helpers.suspend();
        }, backgroundDisconnectMs);
      }

      function unbind(): void {
        clearHiddenTimer();
        // Isolate each cleanup so one throw can't leave later listeners attached.
        dispatchToHandlers(cleanups, helpers.log);
        cleanups.length = 0;
        bound = false;
      }

      return {
        id: 'platform',

        install(socket) {
          // @ts-expect-error — install adds the online store to the socket dynamically
          socket.online = onlineStore.store;
        },

        onOpen() {
          bind();
          return null;
        },

        onClose(...args) {
          const [, , intentional, suspended] = args;
          if (suspended) return;

          if (intentional) {
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

platform.tag = 'platform';
