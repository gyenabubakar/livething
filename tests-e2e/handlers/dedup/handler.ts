import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const base = server({
  authenticate: (request) => requireUsername(request),
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
