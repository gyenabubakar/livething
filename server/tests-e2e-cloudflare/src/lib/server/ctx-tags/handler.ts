import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const TagSelf = event('tag-self', v.object({ tag: v.string() }));
const UntagSelf = event('untag-self', v.object({ tag: v.string() }));
const GetMyTags = event('get-my-tags', v.object({}));
const GetConnectionInfo = event('get-connection-info', v.object({}));
const GetByTag = event('get-by-tag', v.object({ tag: v.string() }));

const TagResult = event('tag-result', v.object({ tags: v.string() }));
const ConnectionInfo = event('connection-info', v.object({ count: v.number() }));
const ConnectionsByTagResult = event(
  'connections-by-tag-result',
  v.object({ tag: v.string(), count: v.number() }),
);

export const ctxTagsHandler = withLifecycle(server<Env>('ctx-tags'))
  .outgoing(TagResult)
  .outgoing(ConnectionInfo)
  .outgoing(ConnectionsByTagResult)
  .onUpgrade((request) => requireUsername(request))
  .incoming(TagSelf, (ctx, payload) => {
    ctx.tag(payload.tag);
    ctx.send('tag-result', { tags: [...ctx.tags, payload.tag].join(',') });
  })
  .incoming(UntagSelf, (ctx, payload) => {
    ctx.untag(payload.tag);
    ctx.send('tag-result', { tags: ctx.tags.filter((t) => t !== payload.tag).join(',') });
  })
  .incoming(GetMyTags, (ctx) => {
    ctx.send('tag-result', { tags: ctx.tags.join(',') });
  })
  .incoming(GetConnectionInfo, (ctx) => {
    ctx.send('connection-info', { count: ctx.getConnections().length });
  })
  .incoming(GetByTag, (ctx, payload) => {
    const matches = ctx.getConnectionsByTag(payload.tag);
    ctx.send('connections-by-tag-result', { tag: payload.tag, count: matches.length });
  })
  .build();
