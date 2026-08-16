import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

/**
 * Resolve the real user id behind a connection. Returns `null` for an
 * anonymous connection — one with no `onUpgrade` hook, or whose upgrade hook
 * returned no user id, so `userId` defaults to `''` at the adapter boundary.
 *
 * Every caller that reaches a socket BY USER IDENTITY — `ctx.user`,
 * `ctx.users.get(id)`, the `usersByKey` fan-out index, a `UserRef` match —
 * must go through this function and handle `null` explicitly, so an
 * anonymous connection can never be reached as though it were a signed-in
 * user.
 *
 * For a per-connection STORAGE key (durable streams need one even for an
 * anonymous connection, so two anonymous sockets never collapse onto the
 * same row), use `connectionStorageKeyOf` instead — a storage key is not a
 * user identity.
 *
 * Lives in its own leaf module (no other runtime imports) so both
 * `_engine/runtime/connection.ts` and `channel/runtime.ts` — which import
 * each other — can reach it without an import cycle.
 */
export function userKeyOf(
  connection: Pick<EngineRuntimeTypes.RuntimeConnection, 'userId'>,
): string | null {
  return connection.userId || null;
}

/**
 * Resolve the storage row key for one connection's durable per-connection
 * state. Returns the connection's user id when it was supplied at upgrade, or
 * its engine-assigned `id` when not. An anonymous connection (no `onUpgrade`,
 * or an upgrade that returned no user id, so `userId` is `''`) has no user
 * identity, and using the empty string as a real key would collapse every
 * anonymous connection onto one row and let them read each other's private
 * durable streams.
 *
 * This is a storage key, not a user identity — it must never back `ctx.user`,
 * `ctx.users.get(...)`, the `usersByKey` fan-out index, or a `UserRef` match.
 * Those use `userKeyOf`, which is honest about an anonymous connection having
 * no user identity at all.
 */
export function connectionStorageKeyOf(
  connection: Pick<EngineRuntimeTypes.RuntimeConnection, 'id' | 'userId'>,
): string {
  return connection.userId || connection.id;
}
