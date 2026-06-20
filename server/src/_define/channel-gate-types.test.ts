/* oxlint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';

interface Env {
  SECRET: string;
}

const base = define({ env: t<Env>(), capabilities: [channels()] });

describe('channel check -> commit inference', () => {
  it('threads the check return type into commit (not any)', () => {
    base.channel('room', {
      subscribe: v.object({ token: v.string() }),
      check(_ctx, input) {
        expectTypeOf(input).toEqualTypeOf<{ token: string }>();
        expectTypeOf(input).not.toBeAny();
        return { role: 'vip' as 'member' | 'vip' };
      },
      commit(_ctx, checkResult) {
        expectTypeOf(checkResult).toEqualTypeOf<{ role: 'member' | 'vip' }>();
        expectTypeOf(checkResult).not.toBeAny();
        expectTypeOf(checkResult.role).toEqualTypeOf<'member' | 'vip'>();
      },
    });
  });

  it('awaits an async check return for commit', () => {
    base.channel('async-room', {
      subscribe: v.object({ id: v.number() }),
      async check(_ctx, input) {
        expectTypeOf(input).toEqualTypeOf<{ id: number }>();
        return { ok: true };
      },
      commit(_ctx, checkResult) {
        expectTypeOf(checkResult).toEqualTypeOf<{ ok: boolean }>();
        expectTypeOf(checkResult).not.toBeAny();
      },
    });
  });

  it('check input is unknown when no subscribe schema is declared', () => {
    base.channel('bare', {
      check(_ctx, input) {
        expectTypeOf(input).toEqualTypeOf<unknown>();
      },
    });
  });

  it('commit with no check sees unknown, not any', () => {
    base.channel('commit-only', {
      commit(_ctx, checkResult) {
        expectTypeOf(checkResult).toEqualTypeOf<unknown>();
        expectTypeOf(checkResult).not.toBeAny();
      },
    });
  });
});

describe('channel handler ctx typing', () => {
  it('typed channel send, members, params not any', () => {
    const room = base.channel(['rooms', 'rooms/:roomId'], {
      outgoing: { emits: { message: t<{ text: string }>() } },
    });
    room.on('send', {
      input: v.object({ text: v.string() }),
      run(ctx, input) {
        expectTypeOf(input).toEqualTypeOf<{ text: string }>();
        expectTypeOf(input).not.toBeAny();
        expectTypeOf(ctx.channel.params).not.toBeAny();
        expectTypeOf(ctx.channel.members()).not.toBeAny();
        ctx.channel.send('message', { text: 'hi' });
      },
    });
  });
});
