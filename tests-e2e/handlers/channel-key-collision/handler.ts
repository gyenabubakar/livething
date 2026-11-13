import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

// Two families whose qualified names could be confused if the engine ever
// concatenated key + scope-value naively:
// - family 'rooms' matches names like 'private-lobby' → reads as 'rooms/private-lobby'
// - family 'rooms-private' matches 'lobby' → reads as 'rooms-private/lobby'
// The engine routes by (family-key, scope-value) tuple, so they stay isolated.
// This fixture proves that.
const BroadcastPayload = v.object({ name: v.string(), text: v.string() });

const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [channels()],
});

const rooms = base.channel(['rooms', 'private-{id}'], {
  capabilities: [emits({ hello: t<{ family: string; text: string }>() })],
});

const roomsPrivate = base.channel(['rooms-private', '{id}'], {
  capabilities: [emits({ hello: t<{ family: string; text: string }>() })],
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

export const channelKeyCollisionDefinition = base.assemble({
  handlers: [handleBroadcastA, handleBroadcastB, rooms, roomsPrivate],
});

export type ChannelKeyCollisionClient = InferClient<typeof channelKeyCollisionDefinition>;
