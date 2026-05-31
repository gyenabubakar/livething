import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

/** Options for the `buffering` primitive. */
export interface BufferingOptions {
  /** Queue outgoing messages while disconnected. Default: `false`. */
  enabled?: boolean;
  /** Maximum buffered messages; oldest dropped when full. Default: `50`. */
  maxSize?: number;
  /** Time-to-live for buffered messages: a number for all events, or a per-event map. */
  ttl?: number | Record<string, number>;
  /** Milliseconds between each buffered message on flush. `0` flushes all at once. Default: `0`. */
  flushInterval?: number;
}

/** Configure message buffering during disconnection. Disabled unless `enabled: true`. */
export function buffering(options?: BufferingOptions): PrimitiveSpec<EmptyTypeFn> {
  return {
    _tag: 'buffering',
    applyConfig(config) {
      if (options?.enabled !== undefined) config.bufferEnabled = options.enabled;
      if (options?.maxSize !== undefined) config.maxBufferSize = options.maxSize;
      if (options?.ttl !== undefined) config.bufferTTL = options.ttl;
      if (options?.flushInterval !== undefined) config.flushInterval = options.flushInterval;
    },
  };
}
