import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Secret = v.object({ text: v.string() });
const TopBeacon = v.object({ text: v.string() });
const SendSecret = v.object({ text: v.string() });
const SendBeacon = v.object({ text: v.string() });

export const replayMembershipGateContract = contract<Env>('replay-membership-gate')({
  sequence: { persist: true },
  dedup: true,
  meta: t<{ username: string }>(),
  definitions: [
    incoming('send-beacon', SendBeacon),
    outgoing('top-beacon', TopBeacon),

    channel('private', {
      definitions: [outgoing('secret', Secret), incoming('send-secret', SendSecret)],
    }),
  ],
});

export const replayMembershipGateHandler = implement(replayMembershipGateContract)
  .customReplay({
    onReplay: (ctx) => {
      ctx.sendReplay(
        'secret',
        { text: 'top-secret-history' },
        { seq: 1, messageId: 'm1', channel: 'private' },
      );
    },
  })
  .onUpgrade((request) => requireUsername(request))
  .on('send-beacon', (ctx, payload) => {
    ctx.send('top-beacon', { text: payload.text });
  })
  .channel('private', (c) =>
    c.on('send-secret', (ctx, payload) => {
      ctx.channel.broadcast('secret', { text: payload.text });
    }),
  )
  .build();
