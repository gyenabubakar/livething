import { event, server } from '@wskit/server';
import { Block, Defer, Disconnect, Skip, ValidationFailed, withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const ThrowBlock = event('throw-block', v.object({}));
const ThrowSkip = event('throw-skip', v.object({}));
const ThrowDefer = event('throw-defer', v.object({}));
const ThrowDisconnect = event('throw-disconnect', v.object({}));
const ThrowValidationFailed = event('throw-validation-failed', v.object({}));
const Leaked = event('leaked', v.object({}));

export const errorsControlFlowHandler = withErrors(
  withLifecycle(server<Env>('errors-control-flow')),
)
  .outgoing(Leaked)
  .onUpgrade((request) => requireUsername(request))
  .incoming(ThrowBlock, (ctx) => {
    throw Block;
    ctx.send('leaked', {});
  })
  .incoming(ThrowSkip, (ctx) => {
    throw Skip;
    ctx.send('leaked', {});
  })
  .incoming(ThrowDefer, () => {
    throw Defer(50);
  })
  .incoming(ThrowDisconnect, () => {
    throw Disconnect(4009, 'force disconnect');
  })
  .incoming(ThrowValidationFailed, () => {
    throw ValidationFailed({
      event: 'throw-validation-failed',
      issues: [{ message: 'forced validation failure' }],
    });
  })
  .build();
