import { define, emits, t } from '@wskit/server';
import { lastSeen } from '@wskit/server/last-seen';
import { persistence } from '@wskit/server/persistence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

// Drives `ctx.lastSeen` — `at`, `atMany`, `online` — end to end. `lastSeen()`
// stamps a durable per-identity timestamp on connect and disconnect (the
// default `track: 'connection'`); no channel is needed to observe it. One
// connection can query ANY identity's standing, including one it does not own,
// so a still-connected member can answer for one that has since disconnected.
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    persistence(),
    lastSeen(),
    emits({
      'last-seen-answer': t<{ identity: string; at: number | null; online: boolean }>(),
      'last-seen-many-answer': t<{ entries: Record<string, number> }>(),
    }),
  ],
});

const AskLastSeen = v.object({ identity: v.string() });

export const handleAskLastSeen = base.on('ask-last-seen', {
  input: AskLastSeen,
  run(ctx, input) {
    ctx.send('last-seen-answer', {
      identity: input.identity,
      at: ctx.lastSeen.at(input.identity),
      online: ctx.lastSeen.online(input.identity),
    });
  },
});

const AskLastSeenMany = v.object({ identities: v.array(v.string()) });

export const handleAskLastSeenMany = base.on('ask-last-seen-many', {
  input: AskLastSeenMany,
  run(ctx, input) {
    const entries = Object.fromEntries(ctx.lastSeen.atMany(input.identities));
    ctx.send('last-seen-many-answer', { entries });
  },
});

export const lastSeenHandler = base.assemble({
  handlers: [handleAskLastSeen, handleAskLastSeenMany],
});

export type LastSeenClient = InferClient<typeof lastSeenHandler>;
