import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const StartBroadcast = event('start-broadcast', v.object({ count: v.number() }));
const BroadcastChunkSchema = v.object({ index: v.number() });

const StartRoomBroadcast = event('start-room-broadcast', v.object({ count: v.number() }));
const RoomBroadcastChunkSchema = v.object({ index: v.number() });

const base = withChannels(withStreams(withLifecycle(server<Env>('stream-broadcast')))).onUpgrade(
  (request) => requireUsername(request),
);

const broadcastStream = base.stream(StartBroadcast, (s) =>
  s
    .chunk(BroadcastChunkSchema)
    .broadcast()
    .generate(async function* (_ctx, payload) {
      for (let i = 0; i < payload.count; i++) {
        yield { index: i };
        await new Promise((r) => setTimeout(r, 10));
      }
    }),
);

// Broadcast stream declared inside a dynamic channel family. Pre-fix, peer
// sends dropped channelScope and the engine either rejected the chunk or
// stripped _channelScope from the wire — clients couldn't tell which family
// the chunk came from. The e2e exercises both paths: the trigger receives
// chunks via its scoped send, peers receive them via the broadcast.
const rooms = base.channel(scope('rooms', /^room:.+$/), (ch) =>
  ch.stream(StartRoomBroadcast, (s) =>
    s
      .chunk(RoomBroadcastChunkSchema)
      .broadcast()
      .generate(async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i++) {
          yield { index: i };
          await new Promise((r) => setTimeout(r, 10));
        }
      }),
  ),
);

export const streamBroadcastHandler = base.use(broadcastStream).use(rooms).build();
