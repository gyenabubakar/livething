import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const TagPayload = v.object({
  kind: v.picklist(['ephemeral', 'persistent']),
  group: v.string(),
  key: v.string(),
});

const FanOutPayload = v.object({ group: v.string(), key: v.string(), text: v.string() });
const CountByPayload = v.object({ group: v.string(), key: v.string() });
const KickByPayload = v.object({ group: v.string(), key: v.string(), reason: v.string() });

const TagsListPayload = v.object({
  tags: v.array(v.object({ kind: v.string(), group: v.string(), key: v.string() })),
});
const FanOutEchoPayload = v.object({ text: v.string(), from: v.string() });
const CountResultPayload = v.object({ count: v.number() });
const RoomMessagePayload = v.object({ text: v.string(), from: v.string() });
const SendInRoomPayload = v.object({ text: v.string() });

export const typedTagsContract = contract('typed-tags', {
  env: t<Env>(),
  persistence: true,
  meta: t<{ username: string }>(),
  tags: (ephemeral, persistent) => [
    ephemeral('user', t<string>()),
    ephemeral('role', t<string>()),
    // Schema-backed group: values are validated on add against this picklist.
    ephemeral('color', v.picklist(['red', 'blue', 'green'])),
    persistent('favorite', t<string>()),
  ],
  definitions: [
    incoming('add-tag', TagPayload),
    incoming('remove-tag', TagPayload),
    incoming('list-my-tags', v.object({})),
    incoming('fan-out-to-tag', FanOutPayload),
    incoming('count-by-tag', CountByPayload),
    incoming('kick-by-tag', KickByPayload),

    outgoing('tags-list', TagsListPayload),
    outgoing('fan-out-echo', FanOutEchoPayload),
    outgoing('count-result', CountResultPayload),

    channel('room', {
      definitions: [
        incoming('send-in-room', SendInRoomPayload),
        outgoing('room-message', RoomMessagePayload),
      ],
    }),
  ],
});

export const typedTagsHandler = implement(typedTagsContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))

  .on('add-tag', (ctx, payload) => {
    if (payload.kind === 'ephemeral')
      ctx.tags.ephemeral(payload.group as 'user' | 'role' | 'color').add(payload.key);
    else ctx.tags.persistent(payload.group as 'favorite').add(payload.key);
  })
  .on('remove-tag', (ctx, payload) => {
    if (payload.kind === 'ephemeral')
      ctx.tags.ephemeral(payload.group as 'user' | 'role' | 'color').remove(payload.key);
    else ctx.tags.persistent(payload.group as 'favorite').remove(payload.key);
  })
  .on('list-my-tags', (ctx) => {
    ctx.send('tags-list', {
      tags: ctx.tags.list().map((t) => ({ kind: t.kind, group: t.group, key: t.key })),
    });
  })
  .on('fan-out-to-tag', (ctx, payload) => {
    ctx.tags
      .ephemeral(payload.group as 'user' | 'role')
      .ref(payload.key)
      .send('fan-out-echo', { text: payload.text, from: ctx.meta.username });
  })
  .on('count-by-tag', (ctx, payload) => {
    const count = ctx.tags
      .ephemeral(payload.group as 'user' | 'role')
      .ref(payload.key)
      .count();
    ctx.send('count-result', { count });
  })
  .on('kick-by-tag', async (ctx, payload) => {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral(payload.group as 'user' | 'role').ref(payload.key), payload.reason);
  })

  .channel('room', (ch) =>
    ch.on('send-in-room', (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        text: payload.text,
        from: ctx.meta.username,
      });
    }),
  )

  .build();

export type TypedTagsClient = InferClient<typeof typedTagsHandler>;
