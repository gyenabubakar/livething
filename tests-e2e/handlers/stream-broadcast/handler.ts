import { server } from '@livething/server';
import { channels } from '@livething/server/channels';
import { stream } from '@livething/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [stream(), channels()],
});

const handleStartBroadcast = base.stream('start-broadcast', {
  input: v.object({ count: v.number() }),
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
  async *run(_ctx, input) {
    for (let i = 0; i < input.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

export const streamBroadcastDefinition = base.assemble({
  handlers: [handleStartBroadcast, handleStartRoomBroadcast, handleStartRoomStream],
});

export type StreamBroadcastClient = InferClient<typeof streamBroadcastDefinition>;
