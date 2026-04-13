import { Disconnect } from '@wskit/server/errors/symbols';
import { base } from '../setup.ts';
import {
  ForceDisconnect,
  GetConnectionInfo,
  GetConnectionsByTagEvent,
  GetQuality,
  SendToConnection,
  SendToTag,
  ServerClose,
  TagSelf,
  UntagSelf,
} from './events.ts';

export const connectionHandlers = base.group((g) =>
  g
    .incoming(GetConnectionInfo, (ctx) => {
      const conns = ctx.getConnections();
      ctx.send('connection-info', {
        count: ctx.connectionCount,
        connections: conns.map((c) => ({ id: c.id, tags: [...c.tags], meta: c.meta })),
      });
    })
    .incoming(TagSelf, (ctx, payload) => {
      ctx.tag(payload.tag);
      ctx.send('tag-result', { tags: [...ctx.tags, payload.tag] });
    })
    .incoming(UntagSelf, (ctx, payload) => {
      ctx.untag(payload.tag);
      ctx.send('tag-result', { tags: ctx.tags.filter((t) => t !== payload.tag) });
    })
    .incoming(SendToTag, (ctx, payload) => {
      ctx.sendTo(payload.tag, 'tagged-message', {
        text: payload.text,
        from: ctx.meta.username,
      });
    })
    .incoming(ServerClose, (ctx, payload) => {
      ctx.close(payload.code, payload.reason);
    })
    .incoming(SendToConnection, (ctx, payload) => {
      ctx.sendToConnection(payload.connectionId, 'send-to-connection-result', {
        text: payload.text,
        from: ctx.meta.username,
      });
    })
    .incoming(GetConnectionsByTagEvent, (ctx, payload) => {
      const conns = ctx.getConnectionsByTag(payload.tag);
      ctx.send('connections-by-tag-result', {
        tag: payload.tag,
        ids: conns.map((c) => c.id),
      });
    })
    .incoming(GetQuality, (ctx) => {
      ctx.send('quality-result', {
        latency: ctx.latency ?? null,
        quality: ctx.quality ?? null,
        bufferedAmount: ctx.bufferedAmount,
      });
    })
    .incoming(ForceDisconnect, () => {
      throw Disconnect(4009, 'Force disconnected by server');
    }),
);
