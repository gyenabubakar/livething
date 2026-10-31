import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = v.object({ text: v.string() });
const SendBatch = v.object({ count: v.number() });

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [channels(), dedup(), sequence({ persist: true }), replay.history()],
});

const rooms = base.channel(['rooms', 'rooms'], {
  replay: true,
  capabilities: [emits({ 'room-message': t<v.InferOutput<typeof RoomMessage>>() })],
});

const handleSendBatch = rooms.on('send-batch', {
  input: SendBatch,
  run(ctx, payload) {
    for (let i = 0; i < payload.count; i++) {
      ctx.channel.broadcast('room-message', { text: `msg-${i}` }, { includeSelf: true });
    }
  },
});

export const replayFamilyKeyEqualsNameDefinition = base.assemble({ handlers: [handleSendBatch] });

export type ReplayFamilyKeyEqualsNameClient = InferClient<
  typeof replayFamilyKeyEqualsNameDefinition
>;
