import { channel, contract, implement, incoming, outgoing, scope, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

// Two families whose qualified names could be confused if the engine ever
// concatenated key + scope-value naively:
// - family 'rooms' matches names like 'private-lobby' → reads as 'rooms/private-lobby'
// - family 'rooms-private' matches 'lobby' → reads as 'rooms-private/lobby'
// The engine routes by (family-key, scope-value) tuple, so they stay isolated.
// This fixture proves that.
const HelloPayload = v.object({ family: v.string(), text: v.string() });
const BroadcastPayload = v.object({ name: v.string(), text: v.string() });

export const channelKeyCollisionContract = contract('channel-key-collision', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('broadcast-a', BroadcastPayload),
    incoming('broadcast-b', BroadcastPayload),

    channel(scope('rooms', 'private-{id}'), {
      definitions: [outgoing('hello', HelloPayload)],
    }),
    channel(scope('rooms-private', '{id}'), {
      definitions: [outgoing('hello', HelloPayload)],
    }),
  ],
});

export const channelKeyCollisionHandler = implement(channelKeyCollisionContract)
  .onUpgrade((request) => requireUsername(request))

  .on('broadcast-a', (ctx, payload) => {
    ctx.channels.get('rooms', payload.name).broadcast('hello', {
      family: 'rooms',
      text: payload.text,
    });
  })
  .on('broadcast-b', (ctx, payload) => {
    ctx.channels.get('rooms-private', payload.name).broadcast('hello', {
      family: 'rooms-private',
      text: payload.text,
    });
  })

  .build();

export type ChannelKeyCollisionClient = InferClient<typeof channelKeyCollisionHandler>;
