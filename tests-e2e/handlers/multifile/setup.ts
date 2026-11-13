// The shared base. Other files import it to attach channel handlers, and the
// top-level handler imports it to call `.assemble()`. The split server +
// assemble composition fans out from here.
import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import type * as v from 'valibot';
import { requireUsername } from '../_shared/authenticate.ts';
import type { NotificationPayload } from './events.ts';

export const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [
    emits({ notification: t<v.InferOutput<typeof NotificationPayload>>() }),
    channels(),
  ],
  onConnect(ctx) {
    ctx.send('notification', { title: `welcome ${ctx.meta.username}` });
  },
});
