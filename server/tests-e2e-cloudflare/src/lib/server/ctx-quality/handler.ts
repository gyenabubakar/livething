import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const GetQuality = event('get-quality', v.object({}));
const QualityResult = event(
  'quality-result',
  v.object({
    quality: v.string(),
    latency: v.union([v.number(), v.null()]),
    bufferedAmount: v.number(),
  }),
);

export const ctxQualityHandler = withLifecycle(server<Env>('ctx-quality'))
  .outgoing(QualityResult)
  .onUpgrade((request) => requireUsername(request))
  .incoming(GetQuality, (ctx) => {
    ctx.send('quality-result', {
      quality: ctx.quality,
      latency: ctx.latency,
      bufferedAmount: ctx.bufferedAmount ?? 0,
    });
  })
  .build();
