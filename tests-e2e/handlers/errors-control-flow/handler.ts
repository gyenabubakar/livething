import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import {
  Block,
  CloseCodes,
  Defer,
  DeferExhausted,
  Disconnect,
  ValidationFailed,
} from '@wskit/server/errors';
import { stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const StreamToken = t<{ index: number }>();

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    channels(),
    stream(),
    emits({
      echoed: t<{ text: string }>(),
      'block-reply': t<{ leaked: boolean }>(),
      'defer-result': t<{ received: boolean }>(),
      'defer-exhausted-result': t<{ event: string; retries: number }>(),
      'validation-error-fired': t<{ event: string }>(),
    }),
  ],
});

base.error((ctx, error, evt) => {
  if (DeferExhausted.matches(error)) {
    ctx.send('defer-exhausted-result', {
      event: evt ?? 'unknown',
      retries: error.detail.retries,
    });
  }
});

base.validationError((ctx, evt) => {
  ctx.send('validation-error-fired', { event: evt });
});

base.intercept((_ctx, frame) => {
  if (frame.event === 'block-test') throw Block;
  if (frame.event === 'disconnect-intercept') throw Disconnect(4011, 'intercepted disconnect');
  // void return — pass payload through unchanged.
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

const handleDeferTest = base.on('defer-test', {
  input: v.object({}),
  async run(ctx) {
    const key = `defer:${ctx.id}`;
    const attempts = ((await ctx.kv.get(key)) as number | undefined) ?? 0;
    await ctx.kv.set(key, attempts + 1);
    if (attempts < 1) throw Defer(50);
    await ctx.kv.delete(key);
    ctx.send('defer-result', { received: true });
  },
});

const handleAlwaysDefer = base.on('always-defer', {
  input: v.object({}),
  run() {
    throw Defer(25);
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

const handleStartDeferStream = base.stream('start-defer-stream', {
  input: v.object({}),
  chunk: StreamToken,
  async *run() {
    throw Defer(25);
    yield { index: 0 };
  },
});

const chat = base.channel('chat', {});

const handleChatAlwaysDefer = chat.on('chat-always-defer', {
  input: v.object({}),
  run() {
    throw Defer(25);
  },
});

export const errorsControlFlowHandler = base.assemble(
  handleDoEcho,
  handleBlockTest,
  handleDeferTest,
  handleAlwaysDefer,
  handleManualValidation,
  handleForceDisconnect,
  handleStartDeferStream,
  handleChatAlwaysDefer,
);

export type ErrorsControlFlowClient = InferClient<typeof errorsControlFlowHandler>;
