/**
 * Shared types for the durable stream runtime. Lives under `_engine/` because
 * only the engine reads these — user code touches the public-facing
 * `resumableStream()` / `recordedStream()` definitions in
 * `~/stream-resumable/` and `~/stream-recorded/`.
 */

import type { DurableStreamKind } from './storage.ts';

export type { DurableStreamKind };

/**
 * Behaviour when the owning connection drops while a durable stream is still
 * running.
 *
 * - `'cancel-but-buffer'` (default) — the framework calls `generator.return()`.
 *   Production stops; the cursor or buffered chunks are preserved for resume.
 * - `'keep-running'` — the framework leaves the generator alone. It keeps
 *   producing into the buffer (recorded) or moving the cursor forward
 *   (resumable) with no client attached. Use sparingly — server resources
 *   stay open until the generator finishes on its own or the retention
 *   window elapses.
 */
export type OnDisconnect = 'cancel-but-buffer' | 'keep-running';

/**
 * Engine-side config block carried on a compiled durable-stream primitive.
 * The dispatcher reads `kind` to decide whether to route to the resumable
 * runtime (re-invoke generator with cursor) or the recorded runtime (replay
 * buffered chunks).
 */
export interface DurableStreamConfig {
  readonly kind: DurableStreamKind;
  readonly onDisconnect: OnDisconnect;
  readonly maxChunks?: number;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
}
