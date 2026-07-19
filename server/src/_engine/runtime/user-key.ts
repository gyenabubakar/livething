import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

/**
 * Resolve the storage row key for one connection — its user key. Returns the
 * connection's user id when it was supplied at upgrade, or its
 * engine-assigned `id` when not. An anonymous connection (no `onUpgrade`, or
 * an upgrade that returned no user id) is a user-of-one: it defaults to
 * `userId: ''` at the adapter boundary, and using that empty string as a
 * real key would collapse every anonymous user onto one row and let them
 * read each other's private durable streams.
 *
 * Lives in its own leaf module (no other runtime imports) so both
 * `_engine/runtime/connection.ts` and `channel/runtime.ts` — which import
 * each other — can reach it without an import cycle.
 */
export function userKeyOf(
  connection: Pick<EngineRuntimeTypes.RuntimeConnection, 'id' | 'userId'>,
): string {
  return connection.userId || connection.id;
}
