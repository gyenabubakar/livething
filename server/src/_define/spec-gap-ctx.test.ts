/* oxlint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { localKey } from '~/local-key/local-key.ts';
import { replay } from '~/replay/capability.ts';
import { describe, expectTypeOf, it } from 'vitest';
import type { InterceptFrame } from '~/intercept/intercept.ts';

interface Env {
  SECRET: string;
}

describe('ctx.sendReplay gating', () => {
  it('omits ctx.sendReplay without a replay capability', () => {
    const base = define({ env: t<Env>(), capabilities: [emits({ msg: t<{ text: string }>() })] });
    base.on('x', {
      run(ctx) {
        // @ts-expect-error ctx.sendReplay needs a replay capability
        ctx.sendReplay;
      },
    });
  });

  it('adds ctx.sendReplay with replay.history()', () => {
    const base = define({
      env: t<Env>(),
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
    const base = define({
      env: t<Env>(),
      capabilities: [emits({ msg: t<{ text: string }>() }), replay.custom()],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.sendReplay).toBeFunction();
      },
    });
  });
});

describe('ctx.ack absent in a channel handler ctx', () => {
  it('does not expose ctx.ack inside a channel on handler', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [channels()],
    });
    const room = base.channel('lobby', { outgoing: { emits: { ping: t<{}>() } } });
    room.on('hello', {
      run(ctx) {
        // @ts-expect-error ctx.ack is not available in a channel handler ctx
        ctx.ack;
        expectTypeOf(ctx.channel.send).toBeFunction();
      },
    });
  });
});

describe('ctx.matches / ctx.unsafeCast typing', () => {
  it('narrows a frame payload to a declared event input (not any)', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [emits({ msg: t<{ text: string }>() })],
    });
    base.intercept((ctx, frame: InterceptFrame) => {
      expectTypeOf(ctx.matches).toBeFunction();
      expectTypeOf(ctx.unsafeCast).toBeFunction();
      const cast = ctx.unsafeCast('send', frame);
      expectTypeOf(cast.payload).not.toBeAny();
      expectTypeOf(cast).toMatchTypeOf<{ event: string }>();
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
