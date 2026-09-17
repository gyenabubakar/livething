import { emits, server, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [dedup(), channels(), emits({ echoed: t<{ text: string }>() })],
});

const handleDoEcho = base.on('do-echo', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.send('echoed', { text: input.text });
  },
});

const room = base.channel('room', {
  capabilities: [emits({})],
});

export const dedupDefinition = base.assemble({ handlers: [handleDoEcho, room] });

export type DedupClient = InferClient<typeof dedupDefinition>;
