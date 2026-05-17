import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withPersistence } from '@wskit/server/persistence';
import { withTags } from '@wskit/server/tags';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const AddTag = event(
  'add-tag',
  v.object({
    kind: v.picklist(['ephemeral', 'persistent']),
    group: v.string(),
    key: v.string(),
  }),
);
const RemoveTag = event(
  'remove-tag',
  v.object({
    kind: v.picklist(['ephemeral', 'persistent']),
    group: v.string(),
    key: v.string(),
  }),
);
const ListMyTags = event('list-my-tags', v.object({}));
const FanOutToTag = event(
  'fan-out-to-tag',
  v.object({ group: v.string(), key: v.string(), text: v.string() }),
);
const CountByTag = event('count-by-tag', v.object({ group: v.string(), key: v.string() }));
const KickByTag = event(
  'kick-by-tag',
  v.object({ group: v.string(), key: v.string(), reason: v.string() }),
);

const TagsList = event(
  'tags-list',
  v.object({ tags: v.array(v.object({ kind: v.string(), group: v.string(), key: v.string() })) }),
);
const FanOutEcho = event('fan-out-echo', v.object({ text: v.string(), from: v.string() }));
const CountResult = event('count-result', v.object({ count: v.number() }));

const RoomMessage = event('room-message', v.object({ text: v.string(), from: v.string() }));
const SendInRoom = event('send-in-room', v.object({ text: v.string() }));

const base = withTags(withPersistence(withChannels(withLifecycle(server<Env>('typed-tags')))))
  .enablePersistence()
  .tagGroups('ephemeral', ['user', 'role'])
  .tagGroups('persistent', ['favorite'])
  .outgoing(TagsList)
  .outgoing(FanOutEcho)
  .outgoing(CountResult)
  .onUpgrade((request, helpers) => requireUsername(request, helpers));

const room = base.channel('room', (c) =>
  c.outgoing(RoomMessage).incoming(SendInRoom, (ctx, payload) => {
    ctx.channel.broadcast('room-message', { text: payload.text, from: ctx.meta.username });
  }),
);

export const typedTagsHandler = base
  .use(room)
  .incoming(AddTag, (ctx, payload) => {
    if (payload.kind === 'ephemeral') {
      ctx.tags.ephemeral(payload.group).add(payload.key);
    } else {
      ctx.tags.persistent(payload.group).add(payload.key);
    }
  })
  .incoming(RemoveTag, (ctx, payload) => {
    if (payload.kind === 'ephemeral') {
      ctx.tags.ephemeral(payload.group).remove(payload.key);
    } else {
      ctx.tags.persistent(payload.group).remove(payload.key);
    }
  })
  .incoming(ListMyTags, (ctx) => {
    ctx.send('tags-list', {
      tags: ctx.tags
        .list()
        .map((t: { group: string; key: string; kind: string }) => ({
          kind: t.kind,
          group: t.group,
          key: t.key,
        })),
    });
  })
  .incoming(FanOutToTag, (ctx, payload) => {
    ctx.tags
      .ephemeral(payload.group)
      .ref(payload.key)
      .send('fan-out-echo', { text: payload.text, from: ctx.meta.username });
  })
  .incoming(CountByTag, (ctx, payload) => {
    const count = ctx.tags.ephemeral(payload.group).ref(payload.key).count();
    ctx.send('count-result', { count });
  })
  .incoming(KickByTag, async (ctx, payload) => {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral(payload.group).ref(payload.key), payload.reason);
  })
  .build();
