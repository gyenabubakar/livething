import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withNamespaces } from '@wskit/server/namespaces';
import { withRequests } from '@wskit/server/requests';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const NsMessage = event('ns-message', v.object({ text: v.string() }));
const SendNs = event('send-ns', v.object({ text: v.string() }));
const BroadcastNs = event('broadcast-ns', v.object({ text: v.string() }));
const GetNsInfo = event('get-ns-info', v.object({}));
const NsInfoSchema = v.object({ namespace: v.string() });

const base = withRequests(withNamespaces(withLifecycle(server<Env>('namespace')))).onUpgrade(
  (request) => requireUsername(request),
);

const ns = base.namespace('ns', (n) =>
  n
    .outgoing(NsMessage)
    .incoming(SendNs, (ctx, payload) => {
      ctx.namespace.send('ns-message', { text: payload.text });
    })
    .incoming(BroadcastNs, (ctx, payload) => {
      ctx.namespace.broadcast('ns-message', { text: payload.text });
    })
    .request(GetNsInfo, NsInfoSchema, (ctx) => {
      ctx.respond({ namespace: ctx.namespace.name });
    }),
);

export const namespaceHandler = base.use(ns).build();
