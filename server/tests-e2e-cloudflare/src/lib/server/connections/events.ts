import { event } from '@wskit/server';
import * as v from 'valibot';

export const GetConnectionInfo = event('get-connection-info', v.object({}));
export const ConnectionInfoResult = event(
  'connection-info',
  v.object({
    count: v.number(),
    connections: v.array(
      v.object({ id: v.string(), tags: v.array(v.string()), meta: v.unknown() }),
    ),
  }),
);

export const TagSelf = event('tag-self', v.object({ tag: v.string() }));
export const UntagSelf = event('untag-self', v.object({ tag: v.string() }));
export const TagResult = event('tag-result', v.object({ tags: v.array(v.string()) }));

export const SendToTag = event('send-to-tag', v.object({ tag: v.string(), text: v.string() }));
export const TaggedMessage = event(
  'tagged-message',
  v.object({ text: v.string(), from: v.string() }),
);

export const ServerClose = event(
  'server-close',
  v.object({ code: v.number(), reason: v.string() }),
);

export const ForceDisconnect = event('force-disconnect', v.object({}));
