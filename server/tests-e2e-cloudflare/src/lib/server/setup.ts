import { server } from '@wskit/server';

import '@wskit/server/ack';
import '@wskit/server/dedup';
import '@wskit/server/errors';
import '@wskit/server/heartbeat';
import '@wskit/server/hibernation';
import '@wskit/server/lifecycle';
import '@wskit/server/sequence';

import { RejectUpgrade } from '@wskit/server/errors/symbols';
import {
  ConnectionInfoResult,
  ConnectionsByTagResult,
  QualityResult,
  SendToConnectionResult,
  TaggedMessage,
  TagResult,
} from './connections/events.ts';
import { RoomMessage } from './dynamic-channel/events.ts';
import { Echoed, UserJoined, UserLeft } from './echo/events.ts';
import { Forbidden, NotFound } from './errors.ts';
import { CleanupCancelled, CleanupDone } from './scheduled/events.ts';
import { KvResult, NotesList } from './storage/events.ts';

export const base = server<Env>('e2e-test')
  .ack()
  .sequence()
  .dedup()
  .heartbeat({ timeout: 60_000 })
  .hibernation()
  .errors(NotFound, Forbidden)
  .outgoing(Echoed)
  .outgoing(UserJoined)
  .outgoing(UserLeft)
  .outgoing(CleanupDone)
  .outgoing(CleanupCancelled)
  .outgoing(NotesList)
  .outgoing(KvResult)
  .outgoing(ConnectionInfoResult)
  .outgoing(TagResult)
  .outgoing(TaggedMessage)
  .outgoing(RoomMessage)
  .outgoing(SendToConnectionResult)
  .outgoing(ConnectionsByTagResult)
  .outgoing(QualityResult)
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { meta: { username }, tags: [username] };
  });
