import { RejectUpgrade } from '@wskit/server/errors';

/**
 * The plain upgrade result: a stable `identity` and inferred `meta`, with no
 * tags. Use this in handlers that do not declare a `user` ephemeral tag group —
 * the upgrade runtime rejects a tag for a group the handler never declared.
 */
interface UsernameUpgrade {
  identity: string;
  meta: { username: string };
}

/**
 * The upgrade result plus the initial `user` ephemeral tag. Use this only in
 * handlers that declare a `user` ephemeral tag group under `tags(...)`.
 */
interface UsernameUpgradeWithUserTag extends UsernameUpgrade {
  tags: { ephemeral: { user: string } };
}

/**
 * Pull `username` from the query string and surface it as identity and meta.
 * Feeds `define()`'s `upgrade(request)`. For handlers that declare a `user`
 * ephemeral tag group and want the tag attached on connect, use
 * {@link requireUsernameWithUserTag} instead.
 */
export function requireUsername(request: Request): UsernameUpgrade {
  const url = new URL(request.url);
  const username = url.searchParams.get('username');
  if (!username) throw RejectUpgrade(4001, 'Missing username');
  return { identity: username, meta: { username } };
}

/**
 * Like {@link requireUsername}, but also attaches a `user:<username>` ephemeral
 * tag. Only valid in handlers that declare a `user` ephemeral tag group.
 */
export function requireUsernameWithUserTag(request: Request): UsernameUpgradeWithUserTag {
  const { identity, meta } = requireUsername(request);
  return { identity, meta, tags: { ephemeral: { user: identity } } };
}

/**
 * Like `requireUsername`, but never rejects: a missing `username` yields an
 * empty identity — an anonymous connection. Used to exercise anonymous-path
 * behavior such as persistence skipping durable membership writes when the
 * identity is empty (`!key.identity`).
 */
export function allowAnonymous(request: Request): UsernameUpgrade {
  const url = new URL(request.url);
  const username = url.searchParams.get('username') ?? '';
  return { identity: username, meta: { username } };
}
