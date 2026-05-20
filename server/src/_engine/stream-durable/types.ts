/** Shared engine-side types for the durable stream runtime. */

import type { OnDisconnect, ResolvedScope } from '~/_engine/runtime/types.ts';
import type { DurableStreamKind } from './storage.ts';

export type { DurableStreamKind, OnDisconnect };

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
