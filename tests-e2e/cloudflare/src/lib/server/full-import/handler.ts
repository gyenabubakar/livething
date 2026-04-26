// Coverage: `@wskit/server/full` exposes every feature method on the builder
// without manual `with*` wrappers. The chain below uses .ack(), .outgoing(),
// .incoming(), .request(), .onUpgrade(), and .onConnect() — methods that come
// from five different feature subpaths. If any of them isn't reachable through
// the full export, this handler stops type-checking.
import { event } from '@wskit/server';
import { server } from '@wskit/server/full';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Greeting = event('greeting', v.object({ text: v.string() }));
const SayHi = event('say-hi', v.object({ name: v.string() }));
const TimeCheck = event('time-check', v.object({ ts: v.number() }));
const TimeCheckResponse = v.object({ ts: v.number(), serverTs: v.number() });

export const fullImportHandler = server<Env>('full-import')
  .ack()
  .outgoing(Greeting)
  .onUpgrade((request) => requireUsername(request))
  .onConnect((ctx) => {
    ctx.send('greeting', { text: `welcome ${ctx.meta.username}` });
  })
  .incoming(SayHi, (ctx, payload) => {
    ctx.send('greeting', { text: `hi ${payload.name}` });
    ctx.ack();
  })
  .request(TimeCheck, TimeCheckResponse, (ctx, payload) => {
    ctx.respond({ ts: payload.ts, serverTs: 1 });
  })
  .build();
