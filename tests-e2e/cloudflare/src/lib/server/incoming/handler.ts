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
    // Schemaless incoming — no validator, so any payload is accepted.
    incoming('echo-anything'),
    incoming('trigger-send-undeclared'),
    incoming('trigger-send-bad-payload'),
    outgoing('echo-pong', v.object({ text: v.string() })),
    outgoing('async-done', v.object({ message: v.string() })),
    outgoing('validation-error-fired', v.object({ event: v.string() })),
    outgoing('anything-echo', v.object({ got: v.unknown() })),
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
  // Schemaless incoming echoes whatever payload it was given.
  .on('echo-anything', (ctx, payload) => {
    ctx.send('anything-echo', { got: payload });
  })
  // Deliberately send an outgoing event that was never declared — the engine
  // must reject it and surface internal-error on the wire (cast needed because
  // the typed surface only allows declared events).
  .on('trigger-send-undeclared', (ctx) => {
    const send = ctx.send as unknown as (event: string, payload: unknown) => boolean;
    send('totally-undeclared', { x: 1 });
  })
  // Deliberately send a declared event with a non-object payload — rejected.
  .on('trigger-send-bad-payload', (ctx) => {
    const send = ctx.send as unknown as (event: string, payload: unknown) => boolean;
    send('echo-pong', 12345);
  })
  .build();

export type IncomingClient = InferClient<typeof incomingHandler>;
