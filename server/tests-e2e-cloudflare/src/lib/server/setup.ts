import { server } from '@wskit/server';
import { RejectUpgrade, withErrors } from '@wskit/server/errors';
import { withInfrastructure } from '@wskit/server/infrastructure';
import { withLifecycle } from '@wskit/server/lifecycle';
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
import {
  CleanupCancelled,
  CleanupDone,
  FlakyTaskResult,
  HeartbeatTick,
} from './scheduled/events.ts';
import { KvResult, NotesList } from './storage/events.ts';

export const base = withLifecycle(withErrors(withInfrastructure(server<Env>('e2e-test'))))
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
  .outgoing(HeartbeatTick)
  .outgoing(FlakyTaskResult)
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { meta: { username }, tags: [username] };
  });
