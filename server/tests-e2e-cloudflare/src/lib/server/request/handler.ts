import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withRequests } from '@wskit/server/requests';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const GetTime = event('get-time', v.object({}));
const TimeResponseSchema = v.object({ iso: v.string(), epoch: v.number() });

export const requestHandler = withRequests(withLifecycle(server<Env>('request')))
  .onUpgrade((request) => requireUsername(request))
  .request(GetTime, TimeResponseSchema, (ctx) => {
    ctx.respond({ iso: new Date().toISOString(), epoch: Date.now() });
  })
  .build();
