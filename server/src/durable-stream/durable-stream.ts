/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Durable-stream extension of the plain `StreamPrimitive`. The compiled
 * `StreamPrimitive` carries an optional `durable` block; the engine
 * dispatcher reads it to decide whether to run the plain stream runtime or
 * the durable runtime.
 */

import type { OnDisconnect } from './definition.ts';
import type { DurableStreamKind } from './storage.ts';

/**
 * Durable-specific config carried alongside a compiled stream primitive.
 * Plain streams leave this undefined; the dispatcher routes on presence.
 */
export interface DurableStreamConfig {
  readonly kind: DurableStreamKind;
  readonly onDisconnect: OnDisconnect;
  readonly maxChunks?: number;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
}
