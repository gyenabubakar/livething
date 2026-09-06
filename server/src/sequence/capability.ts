import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { defineHostCapability } from '~/_define/capability.ts';
import { sequence as sequenceFactory } from '~/sequence/sequence.ts';
import type { SequenceOptions } from '~/sequence/sequence.ts';

/**
 * Number outgoing messages so the client can detect gaps after a reconnect.
 *
 * @param options.persist Keep the counter across server restarts (needs
 *   storage). Defaults to false — an in-memory counter that resets on restart,
 *   which is fine for gap detection.
 * @param options.batchSize How many sequence numbers to reserve per storage
 *   write when persistent. Defaults to 100.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { sequence } from '@wskit/server/sequence';
 *
 * const base = define({ capabilities: [sequence({ persist: true })] });
 * ```
 */
export const sequence = defineHostCapability(
  CAPABILITY_KIND.sequence,
  (options?: SequenceOptions) => sequenceFactory(options),
);
