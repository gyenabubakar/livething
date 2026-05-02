import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Hello = event('hello', v.object({ family: v.string(), name: v.string(), text: v.string() }));
const BroadcastA = event('broadcast-a', v.object({ name: v.string(), text: v.string() }));
const BroadcastB = event('broadcast-b', v.object({ name: v.string(), text: v.string() }));
const MembersA = event('members-a', v.object({ name: v.string() }));
const MembersB = event('members-b', v.object({ name: v.string() }));
const MembersResult = event(
  'members-result',
  v.object({ family: v.string(), name: v.string(), count: v.number() }),
);

const base = withChannels(withLifecycle(server<Env>('channel-key-collision')))
  .onUpgrade((request) => requireUsername(request))
  .outgoing(MembersResult);

// Family A — key 'rooms', accepts names like 'private::lobby'.
const familyA = base.channel(scope('rooms', /^private::.+$/), (c) => c.outgoing(Hello));

// Family B — key 'rooms::private', accepts any name (e.g. 'lobby'). Under the
// old `${scope}::${name}` join, family A + 'private::lobby' collided with
// family B + 'lobby' (both produced 'rooms::private::lobby').
const familyB = base.channel(scope('rooms::private', /^.+$/), (c) => c.outgoing(Hello));

export const channelKeyCollisionHandler = base
  .use(familyA)
  .use(familyB)
  .incoming(BroadcastA, (ctx, payload) => {
    ctx.channels.get('rooms', payload.name).broadcast('hello', {
      family: 'rooms',
      name: payload.name,
      text: payload.text,
    });
  })
  .incoming(BroadcastB, (ctx, payload) => {
    ctx.channels.get('rooms::private', payload.name).broadcast('hello', {
      family: 'rooms::private',
      name: payload.name,
      text: payload.text,
    });
  })
  .incoming(MembersA, (ctx, payload) => {
    const handle = ctx.channels.get('rooms', payload.name);
    ctx.send('members-result', {
      family: 'rooms',
      name: payload.name,
      count: handle.members().length,
    });
  })
  .incoming(MembersB, (ctx, payload) => {
    const handle = ctx.channels.get('rooms::private', payload.name);
    ctx.send('members-result', {
      family: 'rooms::private',
      name: payload.name,
      count: handle.members().length,
    });
  })
  .build();
