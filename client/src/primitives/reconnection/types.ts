/** A snapshot of the reconnection loop, exposed as `socket.reconnection`. */
export interface ReconnectionInfo {
  /** `true` while the client is retrying a dropped (or never-opened) connection. */
  retrying: boolean;
  /** How many retry attempts have started since the last successful open. `0` when idle. */
  attempt: number;
  /**
   * `Date.now()` in ms of the next scheduled retry, or `null` when none is
   * scheduled — either idle, or paused offline until the network returns.
   */
  nextRetryAt: number | null;
}

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

  /**
   * More close codes that should never trigger a retry. These add to the
   * built-in list: `AUTH_INVALID` (4002), `DUPLICATE` (4003) and `BANNED` (4009).
   */
  nonRetryableCodes?: number[];

  /** Pause retries while the device is offline (needs a platform environment). Default: `true`. */
  networkAware?: boolean;
}
