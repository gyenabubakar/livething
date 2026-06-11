/** Shared engine-side types for the durable stream runtime. */

import type { OnDisconnect, ResolvedScope } from '~/_engine/runtime/types.ts';
import type { DurableStreamKind } from './storage.ts';

export type { DurableStreamKind, OnDisconnect };

/**
 * Synthetic key used as the storage row's `identity` column for broadcast
 * durable streams. Encodes the scope (top-level / channel / channel-family)
 * so every connection in scope can resolve the same row regardless of which
 * user identity is holding the lookup.
 */
export function computeBroadcastScopeKey(scope: ResolvedScope): string {
  if (scope.channelName) {
    // The family key and channel name both may contain ':', so a plain-string
    // delimiter can collide (scope 'a:' + name 'b' vs scope 'a' + name ':b').
    // JSON-encode the pair instead: distinct pairs always encode distinctly.
    return scope.channelScope
      ? `__bcast:chf:${JSON.stringify([scope.channelScope, scope.channelName])}__`
      : `__bcast:ch:${scope.channelName}__`;
  }
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
