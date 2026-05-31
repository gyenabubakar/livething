import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const ctxQualityContract = contract('ctx-quality', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('get-quality', v.object({})),
    outgoing(
      'quality-result',
      v.object({
        quality: v.union([v.string(), v.null()]),
        latency: v.union([v.number(), v.null()]),
        bufferedAmount: v.number(),
      }),
    ),
  ],
});

export const ctxQualityHandler = implement(ctxQualityContract)
  .onUpgrade((request) => requireUsername(request))
  .on('get-quality', (ctx) => {
    ctx.send('quality-result', {
      quality: ctx.quality,
      latency: ctx.latency,
      bufferedAmount: ctx.bufferedAmount ?? 0,
    });
  })
  .build();

export type CtxQualityClient = InferClient<typeof ctxQualityHandler>;
