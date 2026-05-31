import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

/** Options for the `keepalive` primitive. */
export interface KeepaliveOptions {
  /** How often to send a keepalive ping in ms. `0` disables. Default: `30_000`. */
  interval?: number;
  /** Consecutive missed pongs before force-closing the socket. Default: `2`. */
  maxMissedPongs?: number;
}

/**
 * Configure keepalive ping/pong and missed-pong detection. Omit for the
 * defaults: 30s interval, 2 missed pongs.
 */
export function keepalive(options?: KeepaliveOptions): PrimitiveSpec<EmptyTypeFn> {
  return {
    _tag: 'keepalive',
    applyConfig(config) {
      if (options?.interval !== undefined) config.pingInterval = options.interval;
      if (options?.maxMissedPongs !== undefined) config.maxMissedPongs = options.maxMissedPongs;
    },
  };
}
