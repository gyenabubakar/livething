import type * as PublicApi from '~/context.ts';

/**
 * Every member name the connectionless context itself owns, as a tuple so a
 * name that is not a real member fails to compile. `Engine.admin()` merges the
 * app's `api` into that context, so an adapter tells the two apart by name: a
 * key outside this set came from the dev's `api` factory.
 *
 * Adapters that expose admin over a transport (rather than in-process) need the
 * distinction to know what to forward — see the Cloudflare adapter, where the
 * app's own methods are promoted onto the RPC target.
 */
const ADMIN_CONTEXT_MEMBER_NAMES = [
  'broadcast',
  'channels',
  'purgeUser',
  'closeConnections',
  'connections',
  'users',
  'connectionCount',
  'sql',
  'kv',
  'schedule',
  'cancelScheduled',
  'log',
  'platform',
  'messageLimits',
  'plugin',
] as const satisfies readonly ConnectionlessContextMember[];

/** A member name of the connectionless context the admin surface is built on. */
type ConnectionlessContextMember = keyof PublicApi.ConnectionlessContext<
  Record<string, unknown>,
  unknown
>;

/** Any connectionless-context member {@link ADMIN_CONTEXT_MEMBER_NAMES} forgot to list. */
export type UnlistedConnectionlessContextMember = Exclude<
  ConnectionlessContextMember,
  (typeof ADMIN_CONTEXT_MEMBER_NAMES)[number]
>;

/** @see ADMIN_CONTEXT_MEMBER_NAMES */
export const ADMIN_CONTEXT_MEMBERS: ReadonlySet<string> = new Set(ADMIN_CONTEXT_MEMBER_NAMES);

/**
 * Names an app's `api` factory may not use. These are not LiveThing's to give away:
 * JavaScript itself assigns them a meaning that an ordinary method would break.
 *
 * - `then` makes any object a thenable, so `await` on the admin surface calls it
 *   instead of resolving. The await never settles.
 * - `constructor`, `toString`, `valueOf`, `__proto__`, and the rest of
 *   `Object.prototype` are already inherited by the plain object the admin
 *   surface is built on. An app member by one of these names is rejected — the
 *   inherited one is already there — and would otherwise go missing without
 *   explanation. The engine ignores only the automatic constructor marker on a
 *   traversed class or ordinary function prototype.
 *
 * The engine enforces this when it builds the admin surface, so every adapter
 * inherits the rule rather than restating it. An adapter needs this set only if
 * it reports the names itself.
 */
export const RESERVED_ADMIN_API_NAMES: ReadonlySet<string> = new Set([
  'then',
  ...Object.getOwnPropertyNames(Object.prototype),
]);
