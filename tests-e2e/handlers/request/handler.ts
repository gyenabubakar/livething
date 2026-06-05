import { channel, contract, implement, namespace, request, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const TimeResponseSchema = v.object({ now: v.string() });
const NsInfoSchema = v.object({ namespace: v.string() });
const ChannelInfoSchema = v.object({ channel: v.string() });
const NoResponseSchema = v.object({ ok: v.boolean() });
const DoubleResponseSchema = v.object({ count: v.number() });
const StrictEchoResponseSchema = v.strictObject({ echoed: v.string() });
const ThrowingRequestResponseSchema = v.object({ never: v.string() });

export const requestContract = contract('request', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    request('get-time', { payload: v.object({}), response: TimeResponseSchema }),
    request('no-response', { payload: v.object({}), response: NoResponseSchema }),
    request('double-response', { payload: v.object({}), response: DoubleResponseSchema }),
    request('strict-echo', {
      payload: v.strictObject({ id: v.string() }),
      response: StrictEchoResponseSchema,
    }),
    request('throwing-request', {
      payload: v.object({}),
      response: ThrowingRequestResponseSchema,
    }),
    // Schemaless request — no payload/response validators, accepts anything.
    request('echo-anything-req'),
    // Test support: a request the server never answers (the handler hangs), so a
    // client can observe disconnect() rejecting a still-pending request.
    request('hang', { payload: v.object({}), response: v.object({ never: v.string() }) }),

    namespace('ns', {
      definitions: [request('get-ns-info', { payload: v.object({}), response: NsInfoSchema })],
    }),

    channel('room', {
      definitions: [
        request('get-channel-info', { payload: v.object({}), response: ChannelInfoSchema }),
      ],
    }),
  ],
});

export const requestHandler = implement(requestContract)
  .onUpgrade((req) => requireUsername(req))
  .request('get-time', (ctx) => {
    ctx.respond({ now: 'fixed-now-string' });
  })
  .request('no-response', () => {
    // Intentionally never call ctx.respond - server should surface a
    // correlated __error__ with code "request-no-response" so the
    // client's pending promise rejects instead of hanging.
  })
  .request('double-response', (ctx) => {
    ctx.respond({ count: 1 });
    ctx.respond({ count: 2 });
  })
  .request('strict-echo', (ctx, payload) => {
    ctx.respond({ echoed: payload.id });
  })
  .request('throwing-request', () => {
    throw new Error('intentional handler throw');
  })
  .request('echo-anything-req', (ctx, payload) => {
    ctx.respond({ got: payload });
  })
  .request('hang', async () => {
    await new Promise<void>(() => {});
  })
  .namespace('ns', (ns) =>
    ns.request('get-ns-info', (ctx) => {
      ctx.respond({ namespace: ctx.namespace.name });
    }),
  )
  .channel('room', (ch) =>
    ch.request('get-channel-info', (ctx) => {
      ctx.respond({ channel: ctx.channel.name });
    }),
  )
  .build();

export type RequestClient = InferClient<typeof requestHandler>;
