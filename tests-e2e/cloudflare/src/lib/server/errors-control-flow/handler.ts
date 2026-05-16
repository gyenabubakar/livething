import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import {
  Block,
  Defer,
  DeferExhausted,
  Disconnect,
  ValidationFailed,
  withErrors,
} from '@wskit/server/errors';
import { withIntercept } from '@wskit/server/intercept';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const DoEcho = event('do-echo', v.object({ text: v.string() }));
const Echoed = event('echoed', v.object({ text: v.string() }));

const BlockTest = event('block-test', v.object({}));
const BlockReply = event('block-reply', v.object({ leaked: v.boolean() }));

const DeferTest = event('defer-test', v.object({}));
const DeferResult = event('defer-result', v.object({ received: v.boolean() }));

const AlwaysDefer = event('always-defer', v.object({}));
const DeferExhaustedResult = event(
  'defer-exhausted-result',
  v.object({ event: v.string(), retries: v.number() }),
);

const ManualValidation = event('manual-validation', v.object({}));
const ValidationErrorFired = event('validation-error-fired', v.object({ event: v.string() }));

const ForceDisconnect = event('force-disconnect', v.object({}));

const ChatAlwaysDefer = event('chat-always-defer', v.object({}));

const StartDeferStream = event('start-defer-stream', v.object({}));
const StreamToken = v.object({ index: v.number() });

const base = withChannels(
  withStreams(withIntercept(withErrors(withLifecycle(server<Env>('errors-control-flow'))))),
)
  .outgoing(Echoed)
  .outgoing(BlockReply)
  .outgoing(DeferResult)
  .outgoing(DeferExhaustedResult)
  .outgoing(ValidationErrorFired)
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
  .incoming(DoEcho, (ctx, payload) => {
    ctx.send('echoed', { text: payload.text });
  })
  .incoming(BlockTest, (ctx) => {
    ctx.send('block-reply', { leaked: true });
  })
  .incoming(DeferTest, async (ctx) => {
    const key = `defer:${ctx.id}`;
    const attempts = ((await ctx.kv.get(key)) as number | undefined) ?? 0;
    await ctx.kv.set(key, attempts + 1);
    if (attempts < 1) throw Defer(50);
    await ctx.kv.delete(key);
    ctx.send('defer-result', { received: true });
  })
  .incoming(AlwaysDefer, () => {
    throw Defer(25);
  })
  .incoming(ManualValidation, () => {
    throw ValidationFailed({
      event: 'manual-validation',
      issues: [{ message: 'forced validation failure' }],
    });
  })
  .incoming(ForceDisconnect, () => {
    throw Disconnect(4009, 'force disconnect');
  });

const chatChannel = base.channel('chat', (c) =>
  c.incoming(ChatAlwaysDefer, () => {
    throw Defer(25);
  }),
);

const deferStream = base.stream(StartDeferStream, (s) =>
  s.chunk(StreamToken).generate(async function* () {
    throw Defer(25);
    yield { index: 0 };
  }),
);

export const errorsControlFlowHandler = base.use(chatChannel).use(deferStream).build();
