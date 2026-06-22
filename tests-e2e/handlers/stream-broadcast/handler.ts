import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const BroadcastChunkSchema = t<{ index: number }>();
const RoomBroadcastChunkSchema = t<{ index: number }>();

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [stream(), channels()],
});

const handleStartBroadcast = base.stream('start-broadcast', {
  input: v.object({ count: v.number() }),
  chunk: BroadcastChunkSchema,
  broadcast: true,
  async *run(_ctx, input) {
    // Negative count is a test sentinel: yield one chunk, then throw so the
    // terminal error fans to the creator AND every peer subscriber.
    if (input.count < 0) {
      yield { index: 0 };
      throw new Error('broadcast boom');
    }
    for (let i = 0; i < input.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 10));
    }
  },
});

const room = base.channel(['rooms', 'room:{id}'], {});

const handleStartRoomBroadcast = room.stream('start-room-broadcast', {
  input: v.object({ count: v.number() }),
  chunk: RoomBroadcastChunkSchema,
  broadcast: true,
  async *run(_ctx, input) {
    for (let i = 0; i < input.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 10));
    }
  },
});

const handleStartRoomStream = room.stream('start-room-stream', {
  input: v.object({ count: v.number() }),
  chunk: RoomBroadcastChunkSchema,
  async *run(_ctx, input) {
    for (let i = 0; i < input.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

export const streamBroadcastHandler = base.assemble(
  handleStartBroadcast,
  handleStartRoomBroadcast,
  handleStartRoomStream,
);

export type StreamBroadcastClient = InferClient<typeof streamBroadcastHandler>;
