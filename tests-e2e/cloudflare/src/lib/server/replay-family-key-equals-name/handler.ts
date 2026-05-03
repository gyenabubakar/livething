import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplay } from '@wskit/server/replay';
import { withSequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event('room-message', v.object({ text: v.string() }));
const SendBatch = event('send-batch', v.object({ count: v.number() }));

const base = withReplay(
  withChannels(
    withSequence(withDedup(withLifecycle(server<Env>('replay-family-key-equals-name')))),
  ),
)
  .sequence({ persist: true })
  .dedup()
  .replay((r) => r)
  .onUpgrade((request) => requireUsername(request));

const roomsFamily = base.channel(scope('rooms', /^rooms$/), (c) =>
  c
    .outgoing(RoomMessage)
    .replay((r) => r)
    .incoming(SendBatch, (ctx, payload) => {
      for (let i = 0; i < payload.count; i++) {
        ctx.channel.broadcast('room-message', { text: `msg-${i}` }, { excludeSelf: false });
      }
    }),
);

export const replayFamilyKeyEqualsNameHandler = base.use(roomsFamily).build();
