// `base` is the shared starting builder. Other files import it to attach
// scoped primitives (channels, namespaces, etc.) and the top-level handler
// imports it to add flat handlers and call .build(). The .use() compose
// pattern fans out from here.
import { server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import { requireUsername } from '../_shared/upgrade.ts';
import { Notification } from './events.ts';

export const base = withChannels(withLifecycle(server<Env>('multifile')))
  .outgoing(Notification)
  .onUpgrade((request) => requireUsername(request));
