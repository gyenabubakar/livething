import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const TagSelf = event('tag-self', v.object({ tag: v.string() }));
const UntagSelf = event('untag-self', v.object({ tag: v.string() }));
const GetByTag = event('get-by-tag', v.object({ tag: v.string() }));
const TagsResult = event('tags-result', v.object({ tag: v.string(), count: v.number() }));

export const ctxTagsHandler = withLifecycle(server<Env>('ctx-tags'))
  .outgoing(TagsResult)
  .onUpgrade((request) => requireUsername(request))
  .incoming(TagSelf, (ctx, payload) => {
    ctx.tag(payload.tag);
  })
  .incoming(UntagSelf, (ctx, payload) => {
    ctx.untag(payload.tag);
  })
  .incoming(GetByTag, (ctx, payload) => {
    const matches = ctx.getConnectionsByTag(payload.tag);
    ctx.send('tags-result', { tag: payload.tag, count: matches.length });
  })
  .build();
