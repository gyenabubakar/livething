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
