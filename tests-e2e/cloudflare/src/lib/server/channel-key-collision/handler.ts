import { channel, contract, implement, incoming, outgoing, scope, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const HelloPayload = v.object({ family: v.string(), name: v.string(), text: v.string() });
const BroadcastAPayload = v.object({ name: v.string(), text: v.string() });
const BroadcastBPayload = v.object({ name: v.string(), text: v.string() });
const MembersAPayload = v.object({ name: v.string() });
const MembersBPayload = v.object({ name: v.string() });
const MembersResultPayload = v.object({
  family: v.string(),
  name: v.string(),
  count: v.number(),
});

export const channelKeyCollisionContract = contract<Env>('channel-key-collision')({
  meta: t<{ username: string }>(),
  definitions: [
    incoming('broadcast-a', BroadcastAPayload),
    incoming('broadcast-b', BroadcastBPayload),
    incoming('members-a', MembersAPayload),
    incoming('members-b', MembersBPayload),

    outgoing('members-result', MembersResultPayload),

    channel(scope('rooms', /^private::.+$/), {
      definitions: [outgoing('hello', HelloPayload)],
    }),
    channel(scope('rooms::private', /^.+$/), {
      definitions: [outgoing('hello', HelloPayload)],
    }),
  ],
});

export const channelKeyCollisionHandler = implement(channelKeyCollisionContract)
  .onUpgrade((request) => requireUsername(request))

  .on('broadcast-a', (ctx, payload) => {
    ctx.channels.get('rooms', payload.name).broadcast('hello', {
      family: 'rooms',
      name: payload.name,
      text: payload.text,
    });
  })
  .on('broadcast-b', (ctx, payload) => {
    ctx.channels.get('rooms::private', payload.name).broadcast('hello', {
      family: 'rooms::private',
      name: payload.name,
      text: payload.text,
    });
  })
  .on('members-a', (ctx, payload) => {
    const handle = ctx.channels.get('rooms', payload.name);
    ctx.send('members-result', {
      family: 'rooms',
      name: payload.name,
      count: handle.members().length,
    });
  })
  .on('members-b', (ctx, payload) => {
    const handle = ctx.channels.get('rooms::private', payload.name);
    ctx.send('members-result', {
      family: 'rooms::private',
      name: payload.name,
      count: handle.members().length,
    });
  })

  .build();

export type ChannelKeyCollisionClient = InferClient<typeof channelKeyCollisionHandler>;
