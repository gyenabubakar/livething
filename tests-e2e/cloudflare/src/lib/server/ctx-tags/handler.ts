import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

function serializeTags(tags: readonly { group: string; key: string }[]): string {
  return tags.map((t) => `${t.group}:${t.key}`).join(',');
}

export const ctxTagsContract = contract<Env>('ctx-tags')({
  meta: t<{ username: string }>(),
  tagGroups: {
    ephemeral: ['user', 'label'],
  },
  definitions: [
    incoming('tag-self', v.object({ tag: v.string() })),
    incoming('untag-self', v.object({ tag: v.string() })),
    incoming('get-my-tags', v.object({})),
    incoming('get-connection-info', v.object({})),
    incoming('get-by-tag', v.object({ tag: v.string() })),

    outgoing('tag-result', v.object({ tags: v.string() })),
    outgoing('connection-info', v.object({ count: v.number() })),
    outgoing('connections-by-tag-result', v.object({ tag: v.string(), count: v.number() })),
  ],
});

export const ctxTagsHandler = implement(ctxTagsContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .on('tag-self', (ctx, payload) => {
    ctx.tags.ephemeral('label').add(payload.tag);
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  })
  .on('untag-self', (ctx, payload) => {
    ctx.tags.ephemeral('label').remove(payload.tag);
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  })
  .on('get-my-tags', (ctx) => {
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  })
  .on('get-connection-info', (ctx) => {
    ctx.send('connection-info', { count: ctx.getConnections().length });
  })
  .on('get-by-tag', (ctx, payload) => {
    const userMatches = ctx.tags.ephemeral('user').ref(payload.tag).connections();
    const labelMatches = ctx.tags.ephemeral('label').ref(payload.tag).connections();
    const seen = new Set<string>();
    for (const m of userMatches) seen.add(m.id);
    for (const m of labelMatches) seen.add(m.id);
    ctx.send('connections-by-tag-result', { tag: payload.tag, count: seen.size });
  })
  .build();

export type CtxTagsClient = InferClient<typeof ctxTagsHandler>;
