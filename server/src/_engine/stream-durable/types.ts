/** Shared engine-side types for the durable stream runtime. */

import type { OnDisconnect } from '~/_engine/runtime/types.ts';
import type { DurableStreamDurability } from './storage.ts';

export type { DurableStreamDurability, OnDisconnect };

/**
 * Engine-side config for one durable stream definition. Built by the compile
 * step from the contract-level `ResumableStreamDef` / `RecordedStreamDef`.
 */
export interface DurableStreamConfig {
  readonly kind: DurableStreamDurability;
  readonly onDisconnect: OnDisconnect;
  readonly maxChunks?: number;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
}
