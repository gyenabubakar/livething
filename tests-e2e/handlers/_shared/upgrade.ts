import { RejectUpgrade } from '@wskit/server/errors';

/**
 * The new `define()` upgrade return shape: a stable `identity`, inferred `meta`,
 * and the ephemeral-tag object sugar `{ ephemeral: { user: <username> } }`.
 * A handler that declares a `user` ephemeral tag group picks the tag up; one
 * that declares no groups simply ignores it (the empty target accepts any keys).
 */
interface UsernameUpgrade {
  identity: string;
  meta: { username: string };
  tags: { ephemeral: { user: string } };
}

/**
 * Pull `username` from the query string and surface it as identity, meta, and an
 * initial `user` ephemeral tag. Feeds `define()`'s `upgrade(request)`.
 */
export function requireUsername(request: Request): UsernameUpgrade {
  const url = new URL(request.url);
  const username = url.searchParams.get('username');
  if (!username) throw RejectUpgrade(4001, 'Missing username');
  return { identity: username, meta: { username }, tags: { ephemeral: { user: username } } };
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
  return { identity: username, meta: { username }, tags: { ephemeral: { user: username } } };
}
