import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `reconnection()`. */
export interface ReconnectionOptions {
  /** How many times to retry before giving up. Use `Infinity` for no limit. Default: `10`. */
  maxAttempts?: number;
  /** Longest wait between attempts, in ms. Default: `30_000`. */
  maxDelay?: number;
  /**
   * Decide whether to retry after a close. Return `true`/`false` to settle it,
   * or `undefined` to fall through to `nonRetryableCodes` and the default.
   */
  shouldReconnect?: (code: number, reason: string) => boolean | void;
  /** Close codes that should never trigger a retry (e.g. "banned"). */
  nonRetryableCodes?: number[];
  /** Pause retries while the device is offline (needs a platform adapter). Default: `true`. */
  networkAware?: boolean;
}

/**
 * Adds automatic reconnection. Without it, a dropped socket simply stays closed —
 * this primitive is what makes the client retry, with a growing delay between
 * tries. It owns that retry loop and only ships when you add it.
 */
export function reconnection(options: ReconnectionOptions = {}): Primitive<EmptyTypeFn> {
  const maxAttempts = options.maxAttempts ?? 10;
  const maxDelay = options.maxDelay ?? 30_000;
  const nonRetryable = new Set(options.nonRetryableCodes ?? []);

  return {
    _tag: 'reconnection',
    applyConfig(config) {
      // platform() reads this to pause retries while offline (wired up later).
      config.networkAware = options.networkAware ?? true;
    },
    setup(helpers) {
      let attempt = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function clearTimer(): void {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }

      // Should we retry this close? Ask other primitives, then your callback,
      // then the no-retry list, and if nobody objects, yes.
      function decide(code: number, reason: string): boolean {
        const fromHooks = helpers.runShouldReconnect(code, reason);
        if (fromHooks === true || fromHooks === false) return fromHooks;
        const fromCallback = options.shouldReconnect?.(code, reason);
        if (fromCallback === true || fromCallback === false) return fromCallback;
        if (nonRetryable.has(code)) return false;
        return true;
      }

      helpers.onUnexpectedClose((code, reason) => {
        if (!decide(code, reason)) {
          helpers.giveUp();
          return;
        }
        if (attempt >= maxAttempts) {
          helpers.failReconnect();
          return;
        }
        const delay = backoffDelay(attempt, maxDelay);
        attempt++;
        helpers.enterReconnecting();
        clearTimer();
        timer = setTimeout(() => {
          timer = null;
          helpers.reopen();
        }, delay);
      });

      return {
        id: 'reconnection',
        onOpen() {
          // A good connection resets the wait back to the start.
          attempt = 0;
          clearTimer();
          return null;
        },
        onClose() {
          clearTimer();
        },
      };
    },
  };
}

/**
 * The wait before the next try, doubling each time (1s, 2s, 4s, …) up to
 * `maxDelay`, with ±30% randomness. The randomness spreads out a crowd of
 * clients so they don't all retry at the same instant and overload the server.
 */
function backoffDelay(attempt: number, maxDelay: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt), maxDelay);
  const jitter = base * 0.3;
  return base - jitter + Math.random() * jitter * 2;
}
