import { define, emits, t } from '@wskit/server';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [sequence(), emits({ tock: t<{}>() })],
});

const handleTick = base.on('tick', {
  input: v.object({}),
  run(ctx) {
    ctx.send('tock', {});
  },
});

export const sequenceHandler = base.assemble({ handlers: [handleTick] });

export type SequenceClient = InferClient<typeof sequenceHandler>;
