import { event, server } from '@wskit/server';
import { withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const EchoPing = event('echo-ping', v.object({ text: v.string() }));
const EchoPong = event('echo-pong', v.object({ text: v.string() }));
const AsyncPing = event('async-ping', v.object({ delay: v.number() }));
const AsyncDone = event('async-done', v.object({ message: v.string() }));
const ValidationErrorFired = event('validation-error-fired', v.object({ event: v.string() }));

export const incomingHandler = withErrors(withLifecycle(server<Env>('incoming')))
  .outgoing(EchoPong)
  .outgoing(AsyncDone)
  .outgoing(ValidationErrorFired)
  .onUpgrade((request) => requireUsername(request))
  .onValidationError((ctx, evt) => {
    ctx.send('validation-error-fired', { event: evt });
  })
  .incoming(EchoPing, (ctx, payload) => {
    ctx.send('echo-pong', { text: payload.text });
  })
  .incoming(AsyncPing, async (ctx, payload) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delay));
    ctx.send('async-done', { message: 'async-done' });
  })
  .build();
