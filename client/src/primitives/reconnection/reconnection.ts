import type { ReconnectionOptions } from '~/primitives/reconnection/types.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/**
 * Adds automatic reconnection. Without it, a dropped socket simply stays closed —
 * this primitive is what makes the client retry, with a growing delay between
 * tries. It owns that retry loop and only ships when you add it.
 */
export function reconnection(options: ReconnectionOptions = {}): Primitive<EmptyTypeFn> {
  const maxAttempts = options.maxAttempts ?? 10;
  const maxDelay = options.maxDelay ?? 30_000;
  const nonRetryable = new Set(options.nonRetryableCodes ?? []);
  const networkAware = options.networkAware ?? true;

  return {
    _tag: 'reconnection',
    setup(helpers) {
      let attempt = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      // Tracks the device's reachability when a platform environment reports it.
      // Stays `true` (timer-only) when nothing supplies an `online` signal.
      let online = true;

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

      function scheduleRetry(): void {
        if (attempt >= maxAttempts) {
          helpers.log.info(`reconnection exhausted after ${maxAttempts} attempts`);
          helpers.failReconnect();
          return;
        }

        const delay = backoffDelay(attempt, maxDelay);
        attempt++;

        helpers.log.info(`reconnecting — attempt ${attempt} in ${Math.round(delay)}ms`);
        helpers.enterReconnecting();
        clearTimer();

        timer = setTimeout(() => {
          timer = null;
          // If a manual connect() (or anything else) already moved us out of
          // 'reconnecting', this retry is stale — don't open a duplicate.
          if (helpers.getState() === 'reconnecting') helpers.reopen();
        }, delay);
      }

      helpers.onUnexpectedClose((code, reason) => {
        if (!decide(code, reason)) {
          helpers.log.info(`reconnection suppressed for close code ${code}`);
          helpers.giveUp();
          return;
        }
        // Offline: don't waste attempts on a doomed retry. Sit in `reconnecting`
        // and let the `online` signal kick off a fresh attempt when it returns.
        if (networkAware && !online) {
          helpers.log.info('offline — pausing reconnection until the network returns');
          helpers.enterReconnecting();
          return;
        }
        scheduleRetry();
      });

      // Pause/resume around the device's network, when a platform environment
      // feeds us the signal. With none, this never fires and we stay timer-only.
      if (networkAware) {
        helpers.onSignal('online', (value) => {
          online = value;
          if (!value) {
            clearTimer();
            return;
          }

          // Back online — reset the backoff and retry now if we were waiting.
          if (helpers.getState() === 'reconnecting') {
            helpers.log.info('back online — resuming reconnection');
            attempt = 0;
            clearTimer();
            helpers.reopen();
          }
        });
      }

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
