import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Secret = v.object({ text: v.string() });
const TopBeacon = v.object({ text: v.string() });
const SendSecret = v.object({ text: v.string() });
const SendBeacon = v.object({ text: v.string() });

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({ 'top-beacon': t<v.InferOutput<typeof TopBeacon>>() }),
    sequence({ persist: true }),
    dedup(),
    channels(),
    replay.custom(),
  ],
});

const handleSendBeacon = base.on('send-beacon', {
  input: SendBeacon,
  run(ctx, payload) {
    ctx.send('top-beacon', { text: payload.text });
  },
});

const privateChannel = base.channel('private', {
  capabilities: [emits({ secret: t<v.InferOutput<typeof Secret>>() })],
});

const handleSendSecret = privateChannel.on('send-secret', {
  input: SendSecret,
  run(ctx, payload) {
    ctx.channel.broadcast('secret', { text: payload.text });
  },
});

privateChannel.replay({
  replay(ctx) {
    ctx.sendReplay('secret', { text: 'top-secret-history' }, { deliverySeq: 1, messageId: 'm1' });
  },
});

export const replayMembershipGateDefinition = base.assemble({
  handlers: [handleSendBeacon, handleSendSecret],
});

export type ReplayMembershipGateClient = InferClient<typeof replayMembershipGateDefinition>;
