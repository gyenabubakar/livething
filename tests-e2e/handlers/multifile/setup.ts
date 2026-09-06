// The shared base. Other files import it to attach channel handlers, and the
// top-level handler imports it to add inline lifecycle hooks and call
// `.assemble()`. The split define + assemble composition fans out from here.
import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import type * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';
import type { NotificationPayload } from './events.ts';

export const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({ notification: t<v.InferOutput<typeof NotificationPayload>>() }),
    channels(),
  ],
});
