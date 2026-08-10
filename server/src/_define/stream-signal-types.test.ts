import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';

/**
 * Phase 5 — `ctx.stream.signal` is an `AbortSignal` in every stream run
 * generator: plain, resumable, recorded, and channel-scoped.
 */
describe('ctx.stream.signal type', () => {
  interface Env {
    DB: unknown;
  }

  it('is an AbortSignal in a plain stream run', () => {
    const base = define({ env: t<Env>(), capabilities: [stream()] });
    base.stream('feed', {
      input: v.object({}),
      async *run(ctx) {
        expectTypeOf(ctx.stream.signal).toEqualTypeOf<AbortSignal>();
        yield { i: 1 };
      },
    });
  });

  it('is an AbortSignal in a resumable stream run (alongside cursor)', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [resumableStream()],
    });
    base.resumableStream('paginate', {
      input: v.object({}),
      cursor: t<{ row: number }>(),
      async *run(ctx) {
        expectTypeOf(ctx.stream.signal).toEqualTypeOf<AbortSignal>();
        expectTypeOf(ctx.stream.cursor).toEqualTypeOf<{ row: number } | null>();
        yield ctx.stream.withCursor({ row: 1 }, { row: 1 });
      },
    });
  });

  it('is an AbortSignal in a recorded stream run', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [recordedStream()],
    });
    base.recordedStream('tokens', {
      input: v.object({}),
      async *run(ctx) {
        expectTypeOf(ctx.stream.signal).toEqualTypeOf<AbortSignal>();
        yield { token: 'a' };
      },
    });
  });

  it('is an AbortSignal in a channel-scoped stream run', () => {
    const base = define({ env: t<Env>(), capabilities: [channels(), stream()] });
    const room = base.channel(['rooms', 'rooms:{id}'], {
      outgoing: { emits: { said: t<{ text: string }>() } },
    });
    room.stream('live', {
      input: v.object({}),
      async *run(ctx) {
        expectTypeOf(ctx.stream.signal).toEqualTypeOf<AbortSignal>();
        yield { text: 'hi' };
      },
    });
  });
});
