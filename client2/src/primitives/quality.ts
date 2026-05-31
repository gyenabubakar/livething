import type { QualityThresholds } from '~/internal/config.ts';
import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

/** Options for the `quality` primitive. */
export interface QualityOptions {
  /** Latency upper bounds (ms) per tier. Default: `{ excellent: 50, good: 150, degraded: 500 }`. */
  thresholds?: QualityThresholds;
}

/** Configure connection-quality latency thresholds. */
export function quality(options?: QualityOptions): PrimitiveSpec<EmptyTypeFn> {
  return {
    _tag: 'quality',
    applyConfig(config) {
      if (options?.thresholds !== undefined) config.qualityThresholds = options.thresholds;
    },
  };
}
