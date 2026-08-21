import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';

/**
 * Phase 6 — `ctx.stream.drain()` is `() => Promise<void>` in every stream run
 * generator, and `highWaterMark` is accepted on every stream config.
 */
describe('ctx.stream.drain type + highWaterMark config', () => {
  interface Env {
    DB: unknown;
  }

  it('drain() is () => Promise<void> in a plain stream and highWaterMark is accepted', () => {
    const base = define({ env: t<Env>(), capabilities: [stream()] });
    base.stream('feed', {
      input: v.object({}),
      highWaterMark: 64 * 1024,
      async *run(ctx) {
        expectTypeOf(ctx.stream.drain).toEqualTypeOf<() => Promise<void>>();
        await ctx.stream.drain();
        yield { i: 1 };
      },
    });
  });

  it('drain() is present in a resumable stream and highWaterMark is accepted', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [resumableStream()],
    });
    base.resumableStream('paginate', {
      input: v.object({}),
      cursor: t<{ row: number }>(),
      highWaterMark: 128 * 1024,
      async *run(ctx) {
        expectTypeOf(ctx.stream.drain).toEqualTypeOf<() => Promise<void>>();
        await ctx.stream.drain();
        yield ctx.stream.withCursor({ row: 1 }, { row: 1 });
      },
    });
  });

  it('drain() is present in a recorded stream and highWaterMark is accepted', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [recordedStream()],
    });
    base.recordedStream('tokens', {
      input: v.object({}),
      highWaterMark: 32 * 1024,
      async *run(ctx) {
        expectTypeOf(ctx.stream.drain).toEqualTypeOf<() => Promise<void>>();
        await ctx.stream.drain();
        yield { token: 'a' };
      },
    });
  });

  it('drain() is present in a channel-scoped stream and highWaterMark is accepted', () => {
    const base = define({ env: t<Env>(), capabilities: [channels(), stream()] });
    const room = base.channel(['rooms', 'rooms:{id}'], {
      outgoing: { emits: { said: t<{ text: string }>() } },
    });
    room.stream('live', {
      input: v.object({}),
      highWaterMark: 16 * 1024,
      async *run(ctx) {
        expectTypeOf(ctx.stream.drain).toEqualTypeOf<() => Promise<void>>();
        await ctx.stream.drain();
        yield { text: 'hi' };
      },
    });
  });
});
