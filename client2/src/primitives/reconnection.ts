import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

/** Options for the `reconnection` primitive. */
export interface ReconnectionOptions {
  /** Maximum retry attempts before giving up. `Infinity` for unlimited. Default: `10`. */
  maxAttempts?: number;
  /** Maximum delay between attempts in ms. Default: `30_000`. */
  maxDelay?: number;
  /**
   * Decide whether to reconnect after a close. Return `true`/`false` for a
   * definitive answer, `undefined` to fall through to `nonRetryableCodes` and
   * the default.
   */
  shouldReconnect?: (code: number, reason: string) => boolean | void;
  /** Close codes that should not trigger reconnection. */
  nonRetryableCodes?: number[];
  /** Pause reconnection while the device is offline (needs a platform adapter). Default: `true`. */
  networkAware?: boolean;
}

/**
 * Configure automatic reconnection (exponential backoff with jitter). Omit it
 * entirely for the defaults: auto-reconnect, 10 attempts, 30s max delay.
 */
export function reconnection(options?: ReconnectionOptions): PrimitiveSpec<EmptyTypeFn> {
  return {
    _tag: 'reconnection',
    applyConfig(config) {
      if (options?.maxAttempts !== undefined) config.maxReconnectAttempts = options.maxAttempts;
      if (options?.maxDelay !== undefined) config.maxReconnectDelay = options.maxDelay;
      if (options?.shouldReconnect !== undefined) config.shouldReconnect = options.shouldReconnect;
      if (options?.nonRetryableCodes !== undefined)
        config.nonRetryableCodes = options.nonRetryableCodes;
      if (options?.networkAware !== undefined) config.networkAware = options.networkAware;
    },
  };
}
