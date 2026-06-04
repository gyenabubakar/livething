import type { TypeFn } from '~/primitives/types.ts';
import type { ScopedApi } from '~/types.ts';

/** Adds `socket.namespace(name)` typed from the contract's `namespaces`. */
export interface NamespacesTypeFn extends TypeFn {
  readonly _api: ScopedApi<this['_contract'], 'namespaces', 'namespace'>;
}

/** Options for `namespaces()`. */
export interface NamespacesOptions {
  /** Buffer TTL for namespace events: one number for all, or a per-event map. */
  ttl?: number | Record<string, number>;
}
