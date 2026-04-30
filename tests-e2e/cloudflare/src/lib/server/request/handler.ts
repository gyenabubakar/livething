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

// Strict-object request: any extra key (including transport markers like
// _correlationId) would normally fail validation. The server's payload
// stripping must run BEFORE this validator sees the payload.
const StrictEcho = event('strict-echo', v.strictObject({ id: v.string() }));
const StrictEchoResponseSchema = v.strictObject({ echoed: v.string() });

// Request whose handler throws — used to pin that the engine threads
// `_correlationId` from the raw payload through to the `_error` frame so
// the client request-response plugin can settle the pending request.
const ThrowingRequest = event('throwing-request', v.object({}));
const ThrowingRequestResponseSchema = v.object({ never: v.string() });

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
  })
  .request(StrictEcho, StrictEchoResponseSchema, (ctx, payload) => {
    ctx.respond({ echoed: payload.id });
  })
  .request(ThrowingRequest, ThrowingRequestResponseSchema, () => {
    throw new Error('intentional handler throw');
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
