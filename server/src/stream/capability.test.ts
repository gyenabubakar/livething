import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import type { InferClient } from '~/infer-client.ts';
import { stream } from './capability.ts';

const base = server({
  capabilities: [stream(), resumableStream(), recordedStream()],
});

const feed = base.stream('feed', {
  input: v.object({ count: v.number() }),
  async *run() {
    yield { index: 1 };
  },
});

const paginate = base.resumableStream('paginate', {
  input: v.object({}),
  // Resumable chunk type comes from an explicit `chunk` — `withCursor` makes
  // yield-inference circular, so it cannot be inferred from what is yielded.
  chunk: t<{ row: number }>(),
  cursor: t<{ row: number }>(),
  async *run(ctx) {
    yield ctx.stream.withCursor({ row: 1 }, { row: 1 });
  },
});

const tokens = base.recordedStream('tokens', {
  input: v.object({}),
  async *run() {
    yield { token: 'a' };
  },
});

const definition = base.assemble({ handlers: [feed, paginate, tokens] });
type C = InferClient<typeof definition>;

describe('stream typing', () => {
  it('infers the chunk type from what the generator yields', () => {
    expectTypeOf<C['streams']['feed']['chunk']>().toEqualTypeOf<{ index: number }>();
    expectTypeOf<C['streams']['tokens']['chunk']>().toEqualTypeOf<{ token: string }>();
  });

  it('surfaces all three kinds under the client streams slot', () => {
    expectTypeOf<C['streams']['paginate']['chunk']>().toEqualTypeOf<{ row: number }>();
    expectTypeOf<C['streams']['feed']['kind']>().toEqualTypeOf<'ephemeral'>();
    expectTypeOf<C['streams']['paginate']['kind']>().toEqualTypeOf<'persistent'>();
  });

  it('types ctx.stream.nudges from the declared nudge map', () => {
    base.stream('chat', {
      nudges: { 'speed-up': v.object({ factor: v.number() }), cancel: null },
      async *run(ctx) {
        const recent = ctx.stream.nudges(yield {});
        expectTypeOf(recent).toEqualTypeOf<
          (
            | { event: 'speed-up'; payload: { factor: number } }
            | { event: 'cancel'; payload: undefined }
          )[]
        >();
      },
    });
  });
});
