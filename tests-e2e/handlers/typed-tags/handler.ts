import { emits, server, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { tags } from '@wskit/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsernameWithUserTag } from '../_shared/upgrade.ts';

const TagPayload = v.object({
  kind: v.picklist(['ephemeral', 'persistent']),
  group: v.string(),
  key: v.string(),
});

const FanOutPayload = v.object({ group: v.string(), key: v.string(), text: v.string() });
const CountByPayload = v.object({ group: v.string(), key: v.string() });
const KickByPayload = v.object({ group: v.string(), key: v.string(), reason: v.string() });
const GroupStatsPayload = v.object({ key: v.string() });

const base = server({
  upgrade: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    channels(),
    tags((ephemeral, persistent) => [
      ephemeral('user', t<string>()),
      ephemeral('role', t<string>()),
      // Schema-backed group: values are validated on add against this picklist.
      ephemeral('color', v.picklist(['red', 'blue', 'green'])),
      persistent('favorite', t<string>()),
    ]),
    emits({
      'tags-list': t<{ tags: Array<{ kind: string; group: string; key: string }> }>(),
      'fan-out-echo': t<{ text: string; from: string }>(),
      'count-result': t<{ count: number }>(),
      'group-stats-result': t<{
        has: boolean;
        keys: string[];
        connections: number;
        count: number;
      }>(),
    }),
  ],
});

const handleAddTag = base.on('add-tag', {
  input: TagPayload,
  run(ctx, payload) {
    if (payload.kind === 'ephemeral')
      ctx.tags.ephemeral(payload.group as 'user' | 'role' | 'color').add(payload.key);
    else ctx.tags.persistent(payload.group as 'favorite').add(payload.key);
  },
});

const handleRemoveTag = base.on('remove-tag', {
  input: TagPayload,
  run(ctx, payload) {
    if (payload.kind === 'ephemeral')
      ctx.tags.ephemeral(payload.group as 'user' | 'role' | 'color').remove(payload.key);
    else ctx.tags.persistent(payload.group as 'favorite').remove(payload.key);
  },
});

const handleListMyTags = base.on('list-my-tags', {
  input: v.object({}),
  run(ctx) {
    ctx.send('tags-list', {
      tags: ctx.tags.list().map((t) => ({ kind: t.kind, group: t.group, key: t.key })),
    });
  },
});

const handleFanOutToTag = base.on('fan-out-to-tag', {
  input: FanOutPayload,
  run(ctx, payload) {
    ctx.tags
      .ephemeral(payload.group as 'user' | 'role')
      .ref(payload.key)
      .broadcast('fan-out-echo', { text: payload.text, from: ctx.meta.username });
  },
});

const handleCountByTag = base.on('count-by-tag', {
  input: CountByPayload,
  run(ctx, payload) {
    const count = ctx.tags
      .ephemeral(payload.group as 'user' | 'role')
      .ref(payload.key)
      .count();
    ctx.send('count-result', { count });
  },
});

const handleGroupStats = base.on('group-stats', {
  input: GroupStatsPayload,
  run(ctx, payload) {
    // Probe the group-level reflection methods on the public GroupHandle.
    // connections() returns objects with methods, so send its length, not the
    // raw snapshots.
    const role = ctx.tags.ephemeral('role');
    ctx.send('group-stats-result', {
      has: role.has(payload.key),
      keys: [...role.keys()],
      connections: role.connections().length,
      count: role.count(),
    });
  },
});

const handleKickByTag = base.on('kick-by-tag', {
  input: KickByPayload,
  async run(ctx, payload) {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral(payload.group as 'user' | 'role').ref(payload.key), {
        reason: payload.reason,
      });
  },
});

const room = base.channel('room', {
  capabilities: [
    emits({
      'room-message': t<{ text: string; from: string }>(),
    }),
  ],
});

const handleSendInRoom = room.on('send-in-room', {
  input: v.object({ text: v.string() }),
  run(ctx, payload) {
    ctx.channel.broadcast('room-message', {
      text: payload.text,
      from: ctx.meta.username,
    });
  },
});

export const typedTagsDefinition = base.assemble({
  handlers: [
    handleAddTag,
    handleRemoveTag,
    handleListMyTags,
    handleFanOutToTag,
    handleCountByTag,
    handleGroupStats,
    handleKickByTag,
    handleSendInRoom,
  ],
});

export type TypedTagsClient = InferClient<typeof typedTagsDefinition>;
