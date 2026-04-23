import { event, server } from '@wskit/server';
import { error, withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const StartTokens = event('start-tokens', v.object({ count: v.number() }));
const StartBoom = event('start-boom', v.object({}));
const StartBoomImmediate = event('start-boom-immediate', v.object({}));
const StartTyped = event('start-typed-error', v.object({}));
const StartCancelObserve = event('start-cancel-observe', v.object({}));
const StartEmpty = event('start-empty', v.object({}));
const Token = v.object({ index: v.number() });
const CancelObserved = event('cancel-observed', v.object({ cancelled: v.boolean() }));

const StreamNotFound = error('not-found', v.object({ id: v.string() }));

export const streamBasicHandler = withStreams(
  withErrors(withLifecycle(server<Env>('stream-basic'))),
)
  .errors(StreamNotFound)
  .outgoing(CancelObserved)
  .onUpgrade((request) => requireUsername(request))
  .stream(StartTokens, (s) =>
    s.chunk(Token).generate(async function* (_ctx, payload) {
      for (let i = 0; i < payload.count; i++) {
        yield { index: i };
        // 75ms pacing so a count=10 stream takes ~750ms; plenty of window
        // for a client _streamCancel to land before completion even under
        // parallel load.
        await new Promise((r) => setTimeout(r, 75));
      }
    }),
  )
  .stream(StartBoom, (s) =>
    s.chunk(Token).generate(async function* () {
      yield { index: 0 };
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('boom');
    }),
  )
  .stream(StartBoomImmediate, (s) =>
    s.chunk(Token).generate(async function* () {
      throw new Error('boom-immediate');
      yield { index: 0 }; // unreachable — satisfies generator type
    }),
  )
  .stream(StartTyped, (s) =>
    s.chunk(Token).generate(async function* () {
      yield { index: 0 };
      await new Promise((r) => setTimeout(r, 20));
      throw StreamNotFound({ id: 'model-missing' });
    }),
  )
  .stream(StartCancelObserve, (s) =>
    s.chunk(Token).generate(async function* (ctx) {
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
    }),
  )
  .stream(StartEmpty, (s) =>
    s.chunk(Token).generate(async function* () {
      // Generator yields nothing; immediately sends _streamEnd
    }),
  )
  .build();
