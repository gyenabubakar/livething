import { emits, server, t } from '@livething/server';
import { dedup } from '@livething/server/dedup';
import { keepalive } from '@livething/server/keepalive';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

// Exercises two durable capability configs in one DO:
//  - sequence({ persist: true }) so the seq counter survives a restart
//  - dedup({ cap: 2 }) so the incoming dedup ring evicts the oldest id
const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [
    keepalive(),
    sequence({ persist: true, batchSize: 5 }),
    dedup({ cap: 2 }),
    emits({ tock: t<{}>(), echoed: t<{ text: string }>() }),
  ],
});

const handleTick = base.on('tick', {
  input: v.object({}),
  run(ctx) {
    ctx.send('tock', {});
  },
});

const handleDoEcho = base.on('do-echo', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.send('echoed', { text: input.text });
  },
});

export const durableConfigDefinition = base.assemble({ handlers: [handleTick, handleDoEcho] });

export type DurableConfigClient = InferClient<typeof durableConfigDefinition>;
