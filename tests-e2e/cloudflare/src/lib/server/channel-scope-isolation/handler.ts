import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplay } from '@wskit/server/replay';
import { withSequence } from '@wskit/server/sequence';
import { withTags } from '@wskit/server/tags';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event(
  'room-message',
  v.object({ family: v.string(), name: v.string(), text: v.string() }),
);
const PrivateMessage = event(
  'private-message',
  v.object({ family: v.string(), name: v.string(), text: v.string() }),
);

const SendInPublic = event('send-in-public', v.object({ name: v.string(), text: v.string() }));
const SendInPrivate = event('send-in-private', v.object({ name: v.string(), text: v.string() }));

const PublicMembers = event('public-members', v.object({ name: v.string() }));
const PublicMembersResult = event(
  'public-members-result',
  v.object({ name: v.string(), count: v.number(), ids: v.array(v.string()) }),
);
const PrivateMembers = event('private-members', v.object({ name: v.string() }));
const PrivateMembersResult = event(
  'private-members-result',
  v.object({ name: v.string(), count: v.number(), ids: v.array(v.string()) }),
);

const KickInPublic = event(
  'kick-in-public',
  v.object({ name: v.string(), tag: v.string(), reason: v.string() }),
);
const KickInPrivate = event(
  'kick-in-private',
  v.object({ name: v.string(), tag: v.string(), reason: v.string() }),
);
const KickAcknowledged = event('kick-acknowledged', v.object({ where: v.string() }));

const PublicBroadcastFromTop = event(
  'public-broadcast-from-top',
  v.object({ name: v.string(), text: v.string() }),
);
const PublicSendDirect = event(
  'public-send-direct',
  v.object({ name: v.string(), text: v.string() }),
);
const PrivateSendDirect = event(
  'private-send-direct',
  v.object({ name: v.string(), text: v.string() }),
);

const base = withTags(
  withReplay(
    withChannels(withSequence(withDedup(withLifecycle(server<Env>('channel-scope-isolation'))))),
  ),
)
  .tagGroups('ephemeral', ['user', 'label'])
  .sequence({ persist: true })
  .dedup()
  .replay((r) => r)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .outgoing(PublicMembersResult)
  .outgoing(PrivateMembersResult)
  .outgoing(KickAcknowledged);

const publicRooms = base.channel(scope('publicRooms', /^room:.+$/), (c) =>
  c.outgoing(RoomMessage).incoming(SendInPublic, (ctx, payload) => {
    ctx.channel.broadcast('room-message', {
      family: 'publicRooms',
      name: payload.name,
      text: payload.text,
    });
  }),
);

const privateRooms = base.channel(scope('privateRooms', /^room:.+$/), (c) =>
  c.outgoing(PrivateMessage).incoming(SendInPrivate, (ctx, payload) => {
    ctx.channel.broadcast('private-message', {
      family: 'privateRooms',
      name: payload.name,
      text: payload.text,
    });
  }),
);

export const channelScopeIsolationHandler = base
  .use(publicRooms)
  .use(privateRooms)
  .incoming(PublicMembers, (ctx, payload) => {
    const handle = ctx.channels.get('publicRooms', payload.name);
    const ids = handle.members().map((m) => m.id);
    ctx.send('public-members-result', { name: payload.name, count: ids.length, ids });
  })
  .incoming(PrivateMembers, (ctx, payload) => {
    const handle = ctx.channels.get('privateRooms', payload.name);
    const ids = handle.members().map((m) => m.id);
    ctx.send('private-members-result', { name: payload.name, count: ids.length, ids });
  })
  .incoming(KickInPublic, async (ctx, payload) => {
    await ctx.channels
      .get('publicRooms', payload.name)
      .kick(ctx.tags.ephemeral('user').ref(payload.tag), payload.reason);
    ctx.send('kick-acknowledged', { where: 'publicRooms' });
  })
  .incoming(KickInPrivate, async (ctx, payload) => {
    await ctx.channels
      .get('privateRooms', payload.name)
      .kick(ctx.tags.ephemeral('user').ref(payload.tag), payload.reason);
    ctx.send('kick-acknowledged', { where: 'privateRooms' });
  })
  .incoming(PublicBroadcastFromTop, (ctx, payload) => {
    ctx.channels.get('publicRooms', payload.name).broadcast('room-message', {
      family: 'publicRooms',
      name: payload.name,
      text: payload.text,
    });
  })
  .incoming(PublicSendDirect, (ctx, payload) => {
    ctx.channels.get('publicRooms', payload.name).send('room-message', {
      family: 'publicRooms',
      name: payload.name,
      text: payload.text,
    });
  })
  .incoming(PrivateSendDirect, (ctx, payload) => {
    ctx.channels.get('privateRooms', payload.name).send('private-message', {
      family: 'privateRooms',
      name: payload.name,
      text: payload.text,
    });
  })
  .build();
