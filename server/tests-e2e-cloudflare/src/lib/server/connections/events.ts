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

export const SendToConnection = event(
  'send-to-connection',
  v.object({ connectionId: v.string(), text: v.string() }),
);
export const SendToConnectionResult = event(
  'send-to-connection-result',
  v.object({ text: v.string(), from: v.string() }),
);
export const SendToConnectionStatus = event(
  'send-to-connection-status',
  v.object({ delivered: v.boolean() }),
);

export const GetConnectionsByTagEvent = event(
  'get-connections-by-tag',
  v.object({ tag: v.string() }),
);
export const ConnectionsByTagResult = event(
  'connections-by-tag-result',
  v.object({ tag: v.string(), ids: v.array(v.string()) }),
);

export const GetQuality = event('get-quality', v.object({}));
export const QualityResult = event(
  'quality-result',
  v.object({
    latency: v.nullable(v.number()),
    quality: v.nullable(v.string()),
    bufferedAmount: v.number(),
  }),
);

export const BroadcastExcludeSelf = event('broadcast-exclude-self', v.object({ text: v.string() }));
export const BroadcastResult = event(
  'broadcast-result',
  v.object({ text: v.string(), from: v.string() }),
);

export const BroadcastBinaryAll = event('broadcast-binary-all', v.object({ size: v.number() }));
export const BroadcastBinaryExcludeSelf = event(
  'broadcast-binary-exclude-self',
  v.object({ size: v.number() }),
);
