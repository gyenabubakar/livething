import { contract, implement, incoming, namespace, outgoing, request, stream } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const NsMessagePayload = v.object({ text: v.string() });
const SendNsPayload = v.object({ text: v.string() });
const BroadcastNsPayload = v.object({ text: v.string() });
const GetNsInfoPayload = v.object({});
const NsInfoSchema = v.object({ namespace: v.string() });
const StartNsStreamPayload = v.object({ count: v.number() });
const NsToken = v.object({ index: v.number() });

export const namespaceContract = contract<Env>('namespace')({
  definitions: [
    namespace('ns', {
      definitions: [
        outgoing('ns-message', NsMessagePayload),
        incoming('send-ns', SendNsPayload),
        incoming('broadcast-ns', BroadcastNsPayload),
        request('get-ns-info', { payload: GetNsInfoPayload, response: NsInfoSchema }),
        stream('start-ns-stream', { payload: StartNsStreamPayload, chunk: NsToken }),
      ],
    }),
  ],
});

export const namespaceHandler = implement(namespaceContract)
  .onUpgrade((request) => requireUsername(request))
  .namespace('ns', (ns) =>
    ns
      .on('send-ns', (ctx, payload) => {
        ctx.namespace.send('ns-message', { text: payload.text });
      })
      .on('broadcast-ns', (ctx, payload) => {
        ctx.namespace.broadcast('ns-message', { text: payload.text }, { excludeSelf: false });
      })
      .request('get-ns-info', (ctx) => {
        return { namespace: ctx.namespace.name };
      })
      .stream('start-ns-stream', async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i++) {
          yield { index: i };
          await new Promise((r) => setTimeout(r, 30));
        }
      }),
  )
  .build();

export type NamespaceClient = InferClient<typeof namespaceHandler>;
