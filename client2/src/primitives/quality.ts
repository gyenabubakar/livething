import type { QualityThresholds } from '~/internal/config.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `quality()`. */
export interface QualityOptions {
  /** Latency cut-offs (ms) per tier. Default: `{ excellent: 50, good: 150, degraded: 500 }`. */
  thresholds?: QualityThresholds;
}

/**
 * Sets the latency cut-offs that decide the quality tier. The `keepalive`
 * primitive reads these when it measures pongs, so this is only useful
 * alongside it.
 */
export function quality(options?: QualityOptions): Primitive<EmptyTypeFn> {
  return {
    _tag: 'quality',
    applyConfig(config) {
      if (options?.thresholds !== undefined) config.qualityThresholds = options.thresholds;
    },
  };
}
