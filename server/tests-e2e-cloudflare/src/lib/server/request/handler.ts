import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withNamespaces } from '@wskit/server/namespaces';
import { withRequests } from '@wskit/server/requests';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const GetTime = event('get-time', v.object({}));
const TimeResponseSchema = v.object({ now: v.string() });

const GetNsInfo = event('get-ns-info', v.object({}));
const NsInfoSchema = v.object({ namespace: v.string() });

const GetChannelInfo = event('get-channel-info', v.object({}));
const ChannelInfoSchema = v.object({ channel: v.string() });

const NoResponseEvent = event('no-response', v.object({}));
const NoResponseSchema = v.object({ ok: v.boolean() });

const DoubleResponseEvent = event('double-response', v.object({}));
const DoubleResponseSchema = v.object({ count: v.number() });

const base = withChannels(withNamespaces(withRequests(withLifecycle(server<Env>('request')))))
  .onUpgrade((request) => requireUsername(request))
  .request(GetTime, TimeResponseSchema, (ctx) => {
    ctx.respond({ now: 'fixed-now-string' });
  })
  .request(NoResponseEvent, NoResponseSchema, () => {
    // Intentionally never call ctx.respond - request should hang
  })
  .request(DoubleResponseEvent, DoubleResponseSchema, (ctx) => {
    ctx.respond({ count: 1 });
    ctx.respond({ count: 2 });
  });

const ns = base.namespace('ns', (n) =>
  n.request(GetNsInfo, NsInfoSchema, (ctx) => {
    ctx.respond({ namespace: ctx.namespace.name });
  }),
);

const ch = base.channel('room', (c) =>
  c.request(GetChannelInfo, ChannelInfoSchema, (ctx) => {
    ctx.respond({ channel: ctx.channel.name });
  }),
);

export const requestHandler = base.use(ns).use(ch).build();
