import { RejectUpgrade } from '@wskit/server/errors';

export function requireUsername(request: Request) {
  const url = new URL(request.url);
  const username = url.searchParams.get('username');
  if (!username) throw RejectUpgrade(4001, 'Missing username');
  return { meta: { username }, tags: [username] };
}
