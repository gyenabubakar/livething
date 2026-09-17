import { RejectUpgrade } from '@wskit/server/errors';

/**
 * The plain upgrade result: a stable `userId` and inferred `meta`, with no
 * tags. Use this in handlers that do not declare a `user` ephemeral tag group —
 * the upgrade runtime rejects a tag for a group the handler never declared.
 */
interface UsernameUpgrade {
  userId: string;
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
 * Pull `username` from the query string and surface it as userId and meta.
 * Feeds `server()`'s `upgrade(request)`. For handlers that declare a `user`
 * ephemeral tag group and want the tag attached on connect, use
 * {@link requireUsernameWithUserTag} instead.
 */
export function requireUsername(request: Request): UsernameUpgrade {
  const url = new URL(request.url);
  const username = url.searchParams.get('username');
  if (!username) throw RejectUpgrade(4001, 'Missing username');

  return { userId: username, meta: { username } };
}

/**
 * Like {@link requireUsername}, but also attaches a `user:<username>` ephemeral
 * tag. Only valid in handlers that declare a `user` ephemeral tag group.
 */
export function requireUsernameWithUserTag(request: Request): UsernameUpgradeWithUserTag {
  const { userId, meta } = requireUsername(request);
  return { userId, meta, tags: { ephemeral: { user: userId } } };
}

/**
 * Like `requireUsername`, but never rejects: a missing `username` yields an
 * empty userId — an anonymous connection. Used to exercise anonymous-path
 * behavior such as persistence skipping durable membership writes when the
 * userId is empty (`!key.userId`).
 */
export function allowAnonymous(request: Request): UsernameUpgrade {
  const url = new URL(request.url);
  const username = url.searchParams.get('username') ?? '';
  return { userId: username, meta: { username } };
}
