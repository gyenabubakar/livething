import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

// Two families whose qualified names could be confused if the engine ever
// concatenated key + scope-value naively:
// - family 'rooms' matches names like 'private-lobby' → reads as 'rooms/private-lobby'
// - family 'rooms-private' matches 'lobby' → reads as 'rooms-private/lobby'
// The engine routes by (family-key, scope-value) tuple, so they stay isolated.
// This fixture proves that.
const BroadcastPayload = v.object({ name: v.string(), text: v.string() });

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [channels()],
});

const rooms = base.channel(['rooms', 'private-{id}'], {
  outgoing: { emits: { hello: t<{ family: string; text: string }>() } },
});

const roomsPrivate = base.channel(['rooms-private', '{id}'], {
  outgoing: { emits: { hello: t<{ family: string; text: string }>() } },
});

const handleBroadcastA = base.on('broadcast-a', {
  input: BroadcastPayload,
  run(ctx, payload) {
    ctx.channels.get('rooms', payload.name).broadcast('hello', {
      family: 'rooms',
      text: payload.text,
    });
  },
});

const handleBroadcastB = base.on('broadcast-b', {
  input: BroadcastPayload,
  run(ctx, payload) {
    ctx.channels.get('rooms-private', payload.name).broadcast('hello', {
      family: 'rooms-private',
      text: payload.text,
    });
  },
});

export const channelKeyCollisionHandler = base.assemble(
  handleBroadcastA,
  handleBroadcastB,
  rooms,
  roomsPrivate,
);

export type ChannelKeyCollisionClient = InferClient<typeof channelKeyCollisionHandler>;
