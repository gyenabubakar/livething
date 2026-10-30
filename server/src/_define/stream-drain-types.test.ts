import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';

/**
 * Phase 6 — `ctx.stream.drain()` is `() => Promise<void>` in every stream run
 * generator.
 */
describe('ctx.stream.drain type', () => {
  it('drain() is () => Promise<void> in a plain stream', () => {
    const base = server({ capabilities: [stream()] });
    base.stream('feed', {
      input: v.object({}),
      async *run(ctx) {
        expectTypeOf(ctx.stream.drain).toEqualTypeOf<() => Promise<void>>();
        await ctx.stream.drain();
        yield { i: 1 };
      },
    });
  });

  it('drain() is present in a recorded stream', () => {
    const base = server({
      capabilities: [recordedStream()],
    });
    base.recordedStream('tokens', {
      input: v.object({}),
      async *run(ctx) {
        expectTypeOf(ctx.stream.drain).toEqualTypeOf<() => Promise<void>>();
        await ctx.stream.drain();
        yield { token: 'a' };
      },
    });
  });

  it('drain() is present in a channel-scoped stream', () => {
    const base = server({ capabilities: [channels(), stream()] });
    const room = base.channel(['rooms', 'rooms:{id}'], {
      capabilities: [emits({ said: t<{ text: string }>() })],
    });
    room.stream('live', {
      input: v.object({}),
      async *run(ctx) {
        expectTypeOf(ctx.stream.drain).toEqualTypeOf<() => Promise<void>>();
        await ctx.stream.drain();
        yield { text: 'hi' };
      },
    });
  });
});
