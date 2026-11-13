import { emits, server, t } from '@livething/server';
import { tags } from '@livething/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsernameWithUserTag } from '../_shared/authenticate.ts';

function serializeTags(tags: readonly { group: string; key: string }[]): string {
  return tags.map((t) => `${t.group}:${t.key}`).join(',');
}

const base = server({
  authenticate: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())]),
    emits({
      'tag-result': t<{ tags: string }>(),
      'connection-info': t<{ count: number }>(),
      'connections-by-tag-result': t<{ tag: string; count: number }>(),
    }),
  ],
});

const handleTagSelf = base.on('tag-self', {
  input: v.object({ tag: v.string() }),
  run(ctx, input) {
    ctx.tags.ephemeral('label').add(input.tag);
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  },
});

const handleUntagSelf = base.on('untag-self', {
  input: v.object({ tag: v.string() }),
  run(ctx, input) {
    ctx.tags.ephemeral('label').remove(input.tag);
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  },
});

const handleGetMyTags = base.on('get-my-tags', {
  input: v.object({}),
  run(ctx) {
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  },
});

const handleGetConnectionInfo = base.on('get-connection-info', {
  input: v.object({}),
  run(ctx) {
    ctx.send('connection-info', { count: ctx.connections.all().length });
  },
});

const handleGetByTag = base.on('get-by-tag', {
  input: v.object({ tag: v.string() }),
  run(ctx, input) {
    const userMatches = ctx.tags.ephemeral('user').ref(input.tag).connections();
    const labelMatches = ctx.tags.ephemeral('label').ref(input.tag).connections();

    const seen = new Set<string>();
    for (const m of userMatches) seen.add(m.id);
    for (const m of labelMatches) seen.add(m.id);

    ctx.send('connections-by-tag-result', { tag: input.tag, count: seen.size });
  },
});

export const ctxTagsDefinition = base.assemble({
  handlers: [
    handleTagSelf,
    handleUntagSelf,
    handleGetMyTags,
    handleGetConnectionInfo,
    handleGetByTag,
  ],
});

export type CtxTagsClient = InferClient<typeof ctxTagsDefinition>;
