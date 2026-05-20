/** Shared engine-side types for the durable stream runtime. */

import type { ResolvedScope } from '~/_engine/runtime/types.ts';
import type { DurableStreamKind } from './storage.ts';

export type { DurableStreamKind };

/**
 * Synthetic key used as the storage row's `identity` column for broadcast
 * durable streams. Encodes the scope (top-level / namespace / channel /
 * channel-family) so every connection in scope can resolve the same row
 * regardless of which user identity is holding the lookup.
 */
export function computeBroadcastScopeKey(scope: ResolvedScope): string {
  if (scope.channelName) {
    return scope.channelScope
      ? `__bcast:chf:${scope.channelScope}:${scope.channelName}__`
      : `__bcast:ch:${scope.channelName}__`;
  }
  if (scope.namespace) return `__bcast:ns:${scope.namespace.name}__`;
  return '__bcast:top__';
}

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

/**
 * Engine-side config for one durable stream definition. Built by the compile
 * step from the contract-level `ResumableStreamDef` / `RecordedStreamDef`.
 */
export interface DurableStreamConfig {
  readonly kind: DurableStreamKind;
  readonly onDisconnect: OnDisconnect;
  readonly maxChunks?: number;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
}
