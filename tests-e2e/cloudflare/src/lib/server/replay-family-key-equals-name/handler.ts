import { channel, contract, implement, incoming, outgoing, scope, t } from '@wskit/server';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = v.object({ text: v.string() });
const SendBatch = v.object({ count: v.number() });

export const replayFamilyKeyEqualsNameContract = contract<Env>('replay-family-key-equals-name')({
  sequence: { persist: true },
  dedup: true,
  replay: true,
  meta: t<{ username: string }>(),
  definitions: [
    channel(scope('rooms', /^rooms$/), {
      replay: true,
      definitions: [outgoing('room-message', RoomMessage), incoming('send-batch', SendBatch)],
    }),
  ],
});

export const replayFamilyKeyEqualsNameHandler = implement(replayFamilyKeyEqualsNameContract)
  .onUpgrade((request) => requireUsername(request))
  .channel('rooms', (c) =>
    c.on('send-batch', (ctx, payload) => {
      for (let i = 0; i < payload.count; i++) {
        ctx.channel.broadcast('room-message', { text: `msg-${i}` }, { excludeSelf: false });
      }
    }),
  )
  .build();
