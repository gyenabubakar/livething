import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplayCustom } from '@wskit/server/replay/custom';
import { withSequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Secret = event('secret', v.object({ text: v.string() }));
const TopBeacon = event('top-beacon', v.object({ text: v.string() }));
const SendSecret = event('send-secret', v.object({ text: v.string() }));
const SendBeacon = event('send-beacon', v.object({ text: v.string() }));

const base = withChannels(
  withReplayCustom(withSequence(withDedup(withLifecycle(server<Env>('replay-membership-gate'))))),
)
  .sequence({ persist: true })
  .dedup()
  .outgoing(TopBeacon)
  .onUpgrade((request) => requireUsername(request));

// Top-level custom replay only — no per-channel replay primitive. The
// onReplay handler always emits one row tagged as a private channel
// message. This is the bug surface: before the fix, a non-member could
// craft `_replay` with `_channel: 'private'` and receive that row.
export const replayMembershipGateHandler = base
  .replayCustom((r) =>
    r.onReplay((ctx) => {
      ctx.sendReplay(
        'secret',
        { text: 'top-secret-history' },
        { seq: 1, messageId: 'm1', channel: 'private' },
      );
    }),
  )
  .use(
    base.channel('private', (c) =>
      c.outgoing(Secret).incoming(SendSecret, (ctx, payload) => {
        ctx.channel.broadcast('secret', { text: payload.text });
      }),
    ),
  )
  .incoming(SendBeacon, (ctx, payload) => {
    ctx.send('top-beacon', { text: payload.text });
  })
  .build();
