import { RejectUpgrade } from '@wskit/server/errors';
import type { TagRef } from '@wskit/server';

/**
 * Pull `username` from the query string and surface it as both identity and
 * meta. When the handler has a `'user'` ephemeral tag group declared, pass
 * the upgrade helpers' `tags` to also attach a `user:<username>` ref.
 */
export function requireUsername(
  request: Request,
  helpers?: {
    tags?: {
      ephemeral(group: string): { ref(key: string): TagRef };
    };
  },
): { identity: string; meta: { username: string }; tags: readonly TagRef[] } {
  const url = new URL(request.url);
  const username = url.searchParams.get('username');
  if (!username) throw RejectUpgrade(4001, 'Missing username');
  const tags = helpers?.tags ? [helpers.tags.ephemeral('user').ref(username)] : [];
  return { identity: username, meta: { username }, tags };
}
