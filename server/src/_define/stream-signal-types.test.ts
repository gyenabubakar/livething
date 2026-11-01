import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';

/**
 * Phase 5 — `ctx.stream.signal` is an `AbortSignal` in every stream run
 * generator: plain, recorded, and channel-scoped.
 */
describe('ctx.stream.signal type', () => {
  it('is an AbortSignal in a plain stream run', () => {
    const base = server({ capabilities: [stream()] });
    base.stream('feed', {
      input: v.object({}),
      async *run(ctx) {
        expectTypeOf(ctx.stream.signal).toEqualTypeOf<AbortSignal>();
        yield { i: 1 };
      },
    });
  });

  it('is an AbortSignal in a recorded stream run', () => {
    const base = server({
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
    const base = server({ capabilities: [channels(), stream()] });
    const room = base.channel(['rooms', 'rooms:{id}'], {
      capabilities: [emits({ said: t<{ text: string }>() })],
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
