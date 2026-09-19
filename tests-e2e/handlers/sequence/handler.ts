import { emits, server, t } from '@livething/server';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [sequence(), emits({ tock: t<{}>() })],
});

const handleTick = base.on('tick', {
  input: v.object({}),
  run(ctx) {
    ctx.send('tock', {});
  },
});

export const sequenceDefinition = base.assemble({ handlers: [handleTick] });

export type SequenceClient = InferClient<typeof sequenceDefinition>;
