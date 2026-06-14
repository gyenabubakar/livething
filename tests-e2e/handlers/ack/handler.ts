import { define, emits, t } from '@wskit/server';
import { ack } from '@wskit/server/ack';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [ack(), emits({ 'ack-check-ok': t<{}>() })],
});

const handleAckCheck = base.on('ack-check', {
  input: v.object({}),
  run(ctx) {
    ctx.send('ack-check-ok', {});
    ctx.ack();
  },
});

const handleThrowMe = base.on('throw-me', {
  input: v.object({}),
  run() {
    throw new Error('intentional failure to prove ack is not emitted on throw');
  },
});

export const ackHandler = base.assemble(handleAckCheck, handleThrowMe);

export type AckClient = InferClient<typeof ackHandler>;
