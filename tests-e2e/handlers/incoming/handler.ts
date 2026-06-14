import { define, emits, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'echo-pong': t<{ text: string }>(),
      'async-done': t<{ message: string }>(),
      'validation-error-fired': t<{ event: string }>(),
      'anything-echo': t<{ got: unknown }>(),
    }),
  ],
});

base.validationError((ctx, evt) => {
  ctx.send('validation-error-fired', { event: evt });
});

const handleEchoPing = base.on('echo-ping', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.send('echo-pong', { text: input.text });
  },
});

const handleAsyncPing = base.on('async-ping', {
  input: v.object({ delay: v.number() }),
  async run(ctx, input) {
    await new Promise((resolve) => setTimeout(resolve, input.delay));
    ctx.send('async-done', { message: 'async-done' });
  },
});

// Schemaless incoming echoes whatever payload it was given.
const handleEchoAnything = base.on('echo-anything', {
  run(ctx, input) {
    ctx.send('anything-echo', { got: input });
  },
});

// Deliberately send an outgoing event that was never declared — the engine
// must reject it and surface internal-error on the wire (cast needed because
// the typed surface only allows declared events).
const handleTriggerSendUndeclared = base.on('trigger-send-undeclared', {
  run(ctx) {
    const send = ctx.send as unknown as (event: string, payload: unknown) => boolean;
    send('totally-undeclared', { x: 1 });
  },
});

// Deliberately send a declared event with a non-object payload — rejected.
const handleTriggerSendBadPayload = base.on('trigger-send-bad-payload', {
  run(ctx) {
    const send = ctx.send as unknown as (event: string, payload: unknown) => boolean;
    send('echo-pong', 12345);
  },
});

export const incomingHandler = base.assemble(
  handleEchoPing,
  handleAsyncPing,
  handleEchoAnything,
  handleTriggerSendUndeclared,
  handleTriggerSendBadPayload,
);

export type IncomingClient = InferClient<typeof incomingHandler>;
