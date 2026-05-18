import { contract, error, implement, outgoing, stream, t } from '@wskit/server';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Token = v.object({ index: v.number() });

const StreamNotFound = error('not-found', v.object({ id: v.string() }));

export const streamBasicContract = contract<Env>('stream-basic')({
  meta: t<{ username: string }>(),
  errors: [StreamNotFound],
  definitions: [
    stream('start-tokens', { payload: v.object({ count: v.number() }), chunk: Token }),
    stream('start-boom', { payload: v.object({}), chunk: Token }),
    stream('start-boom-immediate', { payload: v.object({}), chunk: Token }),
    stream('start-typed-error', { payload: v.object({}), chunk: Token }),
    stream('start-cancel-observe', { payload: v.object({}), chunk: Token }),
    stream('start-empty', { payload: v.object({}), chunk: Token }),
    outgoing('cancel-observed', v.object({ cancelled: v.boolean() })),
  ],
});

export const streamBasicHandler = implement(streamBasicContract)
  .onUpgrade((req) => requireUsername(req))

  .stream('start-tokens', async function* (_ctx, payload) {
    for (let i = 0; i < payload.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 200));
    }
  })

  .stream('start-boom', async function* () {
    yield { index: 0 };
    await new Promise((r) => setTimeout(r, 20));
    throw new Error('boom');
  })

  .stream('start-boom-immediate', async function* () {
    throw new Error('boom-immediate');
    yield { index: 0 }; // unreachable
  })

  .stream('start-typed-error', async function* () {
    yield { index: 0 };
    await new Promise((r) => setTimeout(r, 20));
    throw StreamNotFound({ id: 'model-missing' });
  })

  .stream('start-cancel-observe', async function* (ctx) {
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
  })

  .stream('start-empty', async function* () {
    // Generator yields nothing; immediately sends _streamEnd
  })

  .build();
