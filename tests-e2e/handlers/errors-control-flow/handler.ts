import { emits, server, t } from '@livething/server';
import { Block, CloseCodes, Disconnect, ValidationFailed } from '@livething/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      echoed: t<{ text: string }>(),
      'block-reply': t<{ leaked: boolean }>(),
      'validation-error-fired': t<{ event: string }>(),
    }),
  ],
  onError(ctx, error, evt) {
    if (ValidationFailed.matches(error)) {
      ctx.send('validation-error-fired', { event: evt ?? 'unknown' });
    }
  },
  intercept(_ctx, frame) {
    if (frame.event === 'block-test') throw Block;

    if (frame.event === 'disconnect-intercept') throw Disconnect(4011, 'intercepted disconnect');
    // void return — pass payload through unchanged.
  },
});

const handleDoEcho = base.on('do-echo', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.send('echoed', { text: input.text });
  },
});

const handleBlockTest = base.on('block-test', {
  input: v.object({}),
  run(ctx) {
    ctx.send('block-reply', { leaked: true });
  },
});

const handleManualValidation = base.on('manual-validation', {
  input: v.object({}),
  run() {
    throw ValidationFailed({
      event: 'manual-validation',
      issues: [{ message: 'forced validation failure' }],
    });
  },
});

const handleForceDisconnect = base.on('force-disconnect', {
  input: v.object({}),
  run() {
    throw Disconnect(CloseCodes.BANNED, 'force disconnect');
  },
});

export const errorsControlFlowDefinition = base.assemble({
  handlers: [handleDoEcho, handleBlockTest, handleManualValidation, handleForceDisconnect],
});

export type ErrorsControlFlowClient = InferClient<typeof errorsControlFlowDefinition>;
