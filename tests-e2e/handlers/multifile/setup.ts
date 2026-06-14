// The shared base. Other files import it to attach channel handlers, and the
// top-level handler imports it to add inline lifecycle hooks and call
// `.assemble()`. The split define + assemble composition fans out from here.
import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { requireUsername } from '../_shared/upgrade.ts';
import { NotificationPayload } from './events.ts';

export const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [emits({ notification: NotificationPayload }), channels()],
});
