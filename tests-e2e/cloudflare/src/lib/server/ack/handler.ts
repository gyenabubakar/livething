import { event, server } from '@wskit/server';
import { withAck } from '@wskit/server/ack';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const AckCheck = event('ack-check', v.object({}));
const AckCheckOk = event('ack-check-ok', v.object({}));
const ThrowMe = event('throw-me', v.object({}));

export const ackHandler = withLifecycle(withAck(server<Env>('ack')))
  .ack()
  .outgoing(AckCheckOk)
  .onUpgrade((request) => requireUsername(request))
  .incoming(AckCheck, (ctx) => {
    ctx.send('ack-check-ok', {});
    ctx.ack();
  })
  .incoming(ThrowMe, () => {
    throw new Error('intentional failure to prove ack is not emitted on throw');
  })
  .build();
