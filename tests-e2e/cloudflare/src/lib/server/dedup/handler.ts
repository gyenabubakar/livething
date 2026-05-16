import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const DoEcho = event('do-echo', v.object({ text: v.string() }));
const Echoed = event('echoed', v.object({ text: v.string() }));

const base = withChannels(withDedup(withLifecycle(server<Env>('dedup'))))
  .dedup()
  .outgoing(Echoed)
  .onUpgrade((request) => requireUsername(request))
  .incoming(DoEcho, (ctx, payload) => {
    ctx.send('echoed', { text: payload.text });
  });

const roomChannel = base.channel('room', (ch) => ch);

export const dedupHandler = base.use(roomChannel).build();
