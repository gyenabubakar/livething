import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const EchoPing = event('echo-ping', v.object({ text: v.string() }));
const EchoPong = event('echo-pong', v.object({ text: v.string() }));

export const incomingHandler = withLifecycle(server<Env>('incoming'))
  .outgoing(EchoPong)
  .onUpgrade((request) => requireUsername(request))
  .incoming(EchoPing, (ctx, payload) => {
    ctx.send('echo-pong', { text: payload.text });
  })
  .build();
