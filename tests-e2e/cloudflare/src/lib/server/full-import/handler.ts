// Coverage: the new contract+implement API exposes every feature from
// `@wskit/server` directly — no manual `with*` wrappers, no `/full` subpath
// needed. The chain below uses ack, outgoing, incoming, request, onUpgrade,
// and onConnect — methods that previously lived behind five different feature
// subpaths. If any of them isn't reachable, this handler stops type-checking.
import { contract, implement, incoming, outgoing, request, t } from '@wskit/server';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

export const fullImportContract = contract<Env>('full-import')({
  ack: true,
  meta: t<{ username: string }>(),
  definitions: [
    outgoing('greeting', v.object({ text: v.string() })),
    incoming('say-hi', v.object({ name: v.string() })),
    request('time-check', {
      payload: v.object({ ts: v.number() }),
      response: v.object({ ts: v.number(), serverTs: v.number() }),
    }),
  ],
});

export const fullImportHandler = implement(fullImportContract)
  .onUpgrade((request) => requireUsername(request))
  .onConnect((ctx) => {
    ctx.send('greeting', { text: `welcome ${ctx.meta.username}` });
  })
  .on('say-hi', (ctx, payload) => {
    ctx.send('greeting', { text: `hi ${payload.name}` });
    ctx.ack();
  })
  .request('time-check', (_ctx, payload) => {
    return { ts: payload.ts, serverTs: 1 };
  })
  .build();
