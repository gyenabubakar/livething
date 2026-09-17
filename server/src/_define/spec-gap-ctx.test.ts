/* oxlint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { emits } from '~/emits/emits.ts';
import { intercepts } from '~/intercept/capability.ts';
import { localKey } from '~/local-key/local-key.ts';
import { replay } from '~/replay/capability.ts';
import { describe, expectTypeOf, it } from 'vitest';
import type { InterceptFrame } from '~/intercept/intercept.ts';

describe('ctx.sendReplay gating', () => {
  it('omits ctx.sendReplay without a replay capability', () => {
    const base = server({ capabilities: [emits({ msg: t<{ text: string }>() })] });
    base.on('x', {
      run(ctx) {
        // @ts-expect-error ctx.sendReplay needs a replay capability
        ctx.sendReplay;
      },
    });
  });

  it('adds ctx.sendReplay with replay.history()', () => {
    const base = server({
      capabilities: [emits({ msg: t<{ text: string }>() }), replay.history()],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.sendReplay).toBeFunction();
        expectTypeOf(ctx.sendReplay).parameter(0).toEqualTypeOf<'msg'>();
        expectTypeOf(ctx.sendReplay).parameter(0).not.toBeAny();
      },
    });
  });

  it('adds ctx.sendReplay with replay.custom()', () => {
    const base = server({
      capabilities: [emits({ msg: t<{ text: string }>() }), replay.custom()],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.sendReplay).toBeFunction();
      },
    });
  });

  it('adds ctx.sendReplay with replay.snapshot(), typed to the emits catalog', () => {
    const base = server({
      capabilities: [
        emits({ msg: t<{ text: string }>() }),
        replay.snapshot({ snapshotKey: () => 'k' }),
      ],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.sendReplay).toBeFunction();
        expectTypeOf(ctx.sendReplay).parameter(0).toEqualTypeOf<'msg'>();
        expectTypeOf(ctx.sendReplay).parameter(0).not.toBeAny();
      },
    });
  });
});

describe('ctx.matches / ctx.unsafeCast typing', () => {
  it('narrows a frame payload to a declared event input (not any)', () => {
    const base = server({
      capabilities: [emits({ msg: t<{ text: string }>() }), intercepts()],
    });
    base.intercept((ctx, frame: InterceptFrame) => {
      expectTypeOf(ctx.matches).toBeFunction();
      expectTypeOf(ctx.unsafeCast).toBeFunction();
      const cast = ctx.unsafeCast('send', frame);
      expectTypeOf(cast.payload).not.toBeAny();
      expectTypeOf(cast).toMatchTypeOf<{ event: string }>();
    });
  });

  it('are typed on ctx without intercepts() — they are core', () => {
    const base = server({
      capabilities: [emits({ msg: t<{ text: string }>() })],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.matches).toBeFunction();
        expectTypeOf(ctx.unsafeCast).toBeFunction();
      },
    });
  });
});

describe('localKey() no-arg', () => {
  it('creates a key with no name argument', () => {
    const key = localKey<{ tag: string }>();
    expectTypeOf(key.id).toEqualTypeOf<symbol>();
    expectTypeOf(key.name).toEqualTypeOf<string | undefined>();
    const named = localKey<number>('count');
    expectTypeOf(named.id).toEqualTypeOf<symbol>();
  });
});
