import { server } from '@wskit/server';

import '@wskit/server/ack';
import '@wskit/server/dedup';
import '@wskit/server/errors';
import '@wskit/server/heartbeat';
import '@wskit/server/lifecycle';
import '@wskit/server/sequence';

import { RejectUpgrade } from '@wskit/server/errors/symbols';
import { Echoed, UserJoined, UserLeft } from './echo/events.ts';
import { Forbidden, NotFound } from './errors.ts';
import { CleanupDone } from './scheduled/events.ts';

export const base = server('e2e-test')
  .ack()
  .sequence()
  .dedup()
  .heartbeat({ timeout: 60_000 })
  .errors(NotFound, Forbidden)
  .outgoing(Echoed)
  .outgoing(UserJoined)
  .outgoing(UserLeft)
  .outgoing(CleanupDone)
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { meta: { username }, tags: [username] };
  });
