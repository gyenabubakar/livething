import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withTags } from '@wskit/server/tags';
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

function serializeTags(tags: readonly { group: string; key: string }[]): string {
  return tags.map((t) => `${t.group}:${t.key}`).join(',');
}

export const ctxTagsHandler = withTags(withLifecycle(server<Env>('ctx-tags')))
  .tagGroups('ephemeral', ['user', 'label'])
  .outgoing(TagResult)
  .outgoing(ConnectionInfo)
  .outgoing(ConnectionsByTagResult)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .incoming(TagSelf, (ctx, payload) => {
    ctx.tags.ephemeral('label').add(payload.tag);
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  })
  .incoming(UntagSelf, (ctx, payload) => {
    ctx.tags.ephemeral('label').remove(payload.tag);
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  })
  .incoming(GetMyTags, (ctx) => {
    ctx.send('tag-result', { tags: serializeTags(ctx.tags.list()) });
  })
  .incoming(GetConnectionInfo, (ctx) => {
    ctx.send('connection-info', { count: ctx.getConnections().length });
  })
  .incoming(GetByTag, (ctx, payload) => {
    // The fixture accepts either a username (auto-tagged via `user`) or a
    // custom label tag set via tag-self (under `label`). Try the user group
    // first since onUpgrade attaches usernames there.
    const userMatches = ctx.tags.ephemeral('user').ref(payload.tag).connections();
    const labelMatches = ctx.tags.ephemeral('label').ref(payload.tag).connections();
    const seen = new Set<string>();
    for (const m of userMatches) seen.add(m.id);
    for (const m of labelMatches) seen.add(m.id);
    ctx.send('connections-by-tag-result', { tag: payload.tag, count: seen.size });
  })
  .build();
