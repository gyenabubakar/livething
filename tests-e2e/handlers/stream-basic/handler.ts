import { define, emits, errors, t } from '@wskit/server';
import { error } from '@wskit/server/errors';
import { stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Token = v.object({ index: v.number() });

const StreamNotFound = error('not-found', v.object({ id: v.string() }));

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    stream(),
    emits({ 'cancel-observed': t<{ cancelled: boolean }>() }),
    errors([StreamNotFound]),
  ],
});

const handleStartTokens = base.stream('start-tokens', {
  input: v.object({ count: v.number() }),
  chunk: Token,
  async *run(_ctx, input) {
    for (let i = 0; i < input.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 200));
    }
  },
});

const handleStartBoom = base.stream('start-boom', {
  input: v.object({}),
  chunk: Token,
  async *run() {
    yield { index: 0 };
    await new Promise((r) => setTimeout(r, 20));
    throw new Error('boom');
  },
});

const handleStartBoomImmediate = base.stream('start-boom-immediate', {
  input: v.object({}),
  chunk: Token,
  async *run() {
    throw new Error('boom-immediate');
    yield { index: 0 }; // unreachable
  },
});

const handleStartTypedError = base.stream('start-typed-error', {
  input: v.object({}),
  chunk: Token,
  async *run() {
    yield { index: 0 };
    await new Promise((r) => setTimeout(r, 20));
    throw StreamNotFound({ id: 'model-missing' });
  },
});

const handleStartCancelObserve = base.stream('start-cancel-observe', {
  input: v.object({}),
  chunk: Token,
  async *run(ctx) {
    let completedNaturally = false;
    try {
      for (let i = 0; i < 20; i++) {
        yield { index: i };
        await new Promise((r) => setTimeout(r, 50));
      }
      completedNaturally = true;
    } finally {
      if (!completedNaturally) {
        ctx.send('cancel-observed', { cancelled: true });
      }
    }
  },
});

const handleStartEmpty = base.stream('start-empty', {
  input: v.object({}),
  chunk: Token,
  // Generator yields nothing; immediately sends __streamEnd__
  async *run() {},
});

export const streamBasicHandler = base.assemble(
  handleStartTokens,
  handleStartBoom,
  handleStartBoomImmediate,
  handleStartTypedError,
  handleStartCancelObserve,
  handleStartEmpty,
);

export type StreamBasicClient = InferClient<typeof streamBasicHandler>;
