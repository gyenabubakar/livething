import { channel, contract, implement, incoming, outgoing, stream, t } from '@wskit/server';
import { Block, Defer, DeferExhausted, Disconnect, ValidationFailed } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const StreamToken = v.object({ index: v.number() });

export const errorsControlFlowContract = contract('errors-control-flow', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('do-echo', v.object({ text: v.string() })),
    incoming('block-test', v.object({})),
    incoming('defer-test', v.object({})),
    incoming('always-defer', v.object({})),
    incoming('manual-validation', v.object({})),
    incoming('force-disconnect', v.object({})),

    outgoing('echoed', v.object({ text: v.string() })),
    outgoing('block-reply', v.object({ leaked: v.boolean() })),
    outgoing('defer-result', v.object({ received: v.boolean() })),
    outgoing('defer-exhausted-result', v.object({ event: v.string(), retries: v.number() })),
    outgoing('validation-error-fired', v.object({ event: v.string() })),

    stream('start-defer-stream', {
      payload: v.object({}),
      chunk: StreamToken,
    }),

    channel('chat', {
      definitions: [incoming('chat-always-defer', v.object({}))],
    }),
  ],
});

export const errorsControlFlowHandler = implement(errorsControlFlowContract)
  .onUpgrade((request) => requireUsername(request))
  .onError((ctx, error, evt) => {
    if (DeferExhausted.matches(error)) {
      ctx.send('defer-exhausted-result', {
        event: evt ?? 'unknown',
        retries: error.detail.retries,
      });
    }
  })
  .onValidationError((ctx, evt) => {
    ctx.send('validation-error-fired', { event: evt });
  })
  .intercept((_ctx, message) => {
    if (message.event === 'block-test') throw Block;
    if (message.event === 'disconnect-intercept') throw Disconnect(4011, 'intercepted disconnect');
    // void return — pass payload through unchanged.
  })
  .on('do-echo', (ctx, payload) => {
    ctx.send('echoed', { text: payload.text });
  })
  .on('block-test', (ctx) => {
    ctx.send('block-reply', { leaked: true });
  })
  .on('defer-test', async (ctx) => {
    const key = `defer:${ctx.id}`;
    const attempts = ((await ctx.kv.get(key)) as number | undefined) ?? 0;
    await ctx.kv.set(key, attempts + 1);
    if (attempts < 1) throw Defer(50);
    await ctx.kv.delete(key);
    ctx.send('defer-result', { received: true });
  })
  .on('always-defer', () => {
    throw Defer(25);
  })
  .on('manual-validation', () => {
    throw ValidationFailed({
      event: 'manual-validation',
      issues: [{ message: 'forced validation failure' }],
    });
  })
  .on('force-disconnect', () => {
    throw Disconnect(4009, 'force disconnect');
  })
  .stream('start-defer-stream', async function* () {
    throw Defer(25);
    yield { index: 0 };
  })
  .channel('chat', (ch) =>
    ch.on('chat-always-defer', () => {
      throw Defer(25);
    }),
  )
  .build();

export type ErrorsControlFlowClient = InferClient<typeof errorsControlFlowHandler>;
