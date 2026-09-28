import { LiveThingConfigError } from '@livething/core';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

/**
 * A user id becomes the row key for that user's durable state, so it is capped
 * like a wire field. Rejected rather than truncated: two long ids cut to the
 * same prefix would silently share one row.
 */
const MAX_USER_ID_LENGTH = 256;

/**
 * Start of the key space LiveThing keeps for itself. Some rows are filed under a
 * key the framework invents rather than a real user — a broadcast stream, for
 * instance, is stored against its channel so every subscriber resolves the same
 * row. Those keys all begin with this prefix, and a real user id may not, or an
 * app could hand someone an id that lands in the same row space and lets them
 * read a stream that is not theirs.
 */
export const RESERVED_USER_ID_PREFIX = '__';

/**
 * Reject a user id the framework cannot safely store. Runs at the boundary
 * where a user id first arrives, so the app hears about it at the upgrade that
 * produced it rather than at some later read.
 */
export function assertUsableUserId(userId: string): void {
  if (userId.length > MAX_USER_ID_LENGTH) {
    throw new LiveThingConfigError(
      `the user id returned from onUpgrade is ${userId.length} characters; the most allowed is ${MAX_USER_ID_LENGTH}. Use a stable id such as a user id or a ULID, not a token.`,
    );
  }

  if (userId.startsWith(RESERVED_USER_ID_PREFIX)) {
    throw new LiveThingConfigError(
      `the user id returned from onUpgrade starts with "${RESERVED_USER_ID_PREFIX}", which is reserved for keys LiveThing files internally. Give this user an id that starts with anything else.`,
    );
  }
}

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
