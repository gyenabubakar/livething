import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const incomingContract = contract('incoming', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('echo-ping', v.object({ text: v.string() })),
    incoming('async-ping', v.object({ delay: v.number() })),
    outgoing('echo-pong', v.object({ text: v.string() })),
    outgoing('async-done', v.object({ message: v.string() })),
    outgoing('validation-error-fired', v.object({ event: v.string() })),
  ],
});

export const incomingHandler = implement(incomingContract)
  .onUpgrade((request) => requireUsername(request))
  .onValidationError((ctx, evt) => {
    ctx.send('validation-error-fired', { event: evt });
  })
  .on('echo-ping', (ctx, payload) => {
    ctx.send('echo-pong', { text: payload.text });
  })
  .on('async-ping', async (ctx, payload) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delay));
    ctx.send('async-done', { message: 'async-done' });
  })
  .build();

export type IncomingClient = InferClient<typeof incomingHandler>;
