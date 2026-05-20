/** Shared engine-side types for the durable stream runtime. */

import type { DurableStreamKind } from './storage.ts';

export type { DurableStreamKind };

/**
 * What the framework does to a durable stream's generator when the owning
 * connection drops.
 *
 * - `'cancel-but-buffer'` (default) — stop the generator; keep the cursor /
 *   buffered chunks for resume.
 * - `'keep-running'` — leave the generator producing into storage with no
 *   client attached. Server resources stay open until it ends on its own.
 */
export type OnDisconnect = 'cancel-but-buffer' | 'keep-running';

export interface DurableStreamConfig {
  readonly kind: DurableStreamKind;
  readonly onDisconnect: OnDisconnect;
  readonly maxChunks?: number;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
}
