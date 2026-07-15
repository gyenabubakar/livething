import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { replay } from '@wskit/server/replay';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = v.object({ text: v.string() });
const SendBatch = v.object({ count: v.number() });

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [channels(), dedup(), sequence({ persist: true }), replay.history()],
});

const rooms = base.channel(['rooms', 'rooms'], {
  replay: true,
  outgoing: { emits: { 'room-message': t<v.InferOutput<typeof RoomMessage>>() } },
});

const handleSendBatch = rooms.on('send-batch', {
  input: SendBatch,
  run(ctx, payload) {
    for (let i = 0; i < payload.count; i++) {
      ctx.channel.broadcast('room-message', { text: `msg-${i}` }, { excludeSelf: false });
    }
  },
});

export const replayFamilyKeyEqualsNameHandler = base.assemble({ handlers: [handleSendBatch] });

export type ReplayFamilyKeyEqualsNameClient = InferClient<typeof replayFamilyKeyEqualsNameHandler>;
