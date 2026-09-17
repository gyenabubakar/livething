import { emits, server, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'who-am-i-result': t<{ username: string }>(),
      'members-list-result': t<{ members: string[] }>(),
      'broadcast-identity-received': t<{ from: string }>(),
    }),
  ],
});

const handleWhoAmI = base.on('who-am-i', {
  input: v.object({}),
  run(ctx) {
    ctx.send('who-am-i-result', { username: ctx.meta.username });
  },
});

const handleListMembers = base.on('list-members', {
  input: v.object({}),
  run(ctx) {
    const peers = ctx.connections.all();
    const usernames = peers.map((p) => (p.meta.username as string) ?? 'unknown');
    ctx.send('members-list-result', { members: usernames });
  },
});

const handleBroadcastIdentity = base.on('broadcast-identity', {
  input: v.object({}),
  run(ctx) {
    ctx.broadcast('broadcast-identity-received', { from: ctx.meta.username });
  },
});

export const ctxMetaDefinition = base.assemble({
  handlers: [handleWhoAmI, handleListMembers, handleBroadcastIdentity],
});

export type CtxMetaClient = InferClient<typeof ctxMetaDefinition>;
