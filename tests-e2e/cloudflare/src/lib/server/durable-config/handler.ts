import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

// Exercises two durable contract configs in one DO:
//  - sequence: { persist: true } so the seq counter survives a restart
//  - dedup: { cap: 2 } so the incoming dedup ring evicts the oldest id
export const durableConfigContract = contract('durable-config', {
  env: t<Env>(),
  sequence: { persist: true, batchSize: 5 },
  dedup: { cap: 2 },
  meta: t<{ username: string }>(),
  definitions: [
    incoming('tick', v.object({})),
    outgoing('tock', v.object({})),
    incoming('do-echo', v.object({ text: v.string() })),
    outgoing('echoed', v.object({ text: v.string() })),
  ],
});

export const durableConfigHandler = implement(durableConfigContract)
  .onUpgrade((request) => requireUsername(request))
  .on('tick', (ctx) => {
    ctx.send('tock', {});
  })
  .on('do-echo', (ctx, payload) => {
    ctx.send('echoed', { text: payload.text });
  })
  .build();

export type DurableConfigClient = InferClient<typeof durableConfigHandler>;
