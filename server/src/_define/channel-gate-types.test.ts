/* oxlint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { tags } from '~/tags/capability.ts';
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
      capabilities: [emits({ message: t<{ text: string }>() })],
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

describe('channel gate surface typing', () => {
  it('omits channel-only handles from gate contexts but keeps channel membership reads', () => {
    const gateBase = define({ env: t<Env>(), capabilities: [channels()] });
    gateBase.channel('gated', {
      check(ctx) {
        expectTypeOf(ctx.channel.members).toBeFunction();
        const handle = ctx.channels.get('gated');
        // @ts-expect-error — channel-only inbox access is not part of gate ctx.
        handle.inbox;
        // @ts-expect-error — channel-only read-receipts access is not part of gate ctx.
        handle.readReceipts;
      },
    });
  });

  it('omits channel-owned request methods from check, commit, and revalidate', () => {
    const requestGateBase = define({
      env: t<Env>(),
      capabilities: [
        channels(),
        serverRequests({
          ask: { out: t<{ prompt: string }>(), in: v.object({ ok: v.boolean() }) },
        }),
        tags((ephemeral) => [ephemeral('role', t<string>())]),
      ],
    });

    requestGateBase.channel('request-gated', {
      capabilities: [
        serverRequests({
          ask: { out: t<{ prompt: string }>(), in: v.object({ ok: v.boolean() }) },
        }),
      ],
      check(ctx) {
        // The request map belongs to this same config object, so it is not
        // available while the gate callbacks are being contextually typed.
        // @ts-expect-error — channel request methods are not part of gate ctx.
        ctx.channel.request;
        // @ts-expect-error — channel request methods are not part of gate ctx.
        ctx.channel.broadcastRequest;
        expectTypeOf(ctx.channel.send).toBeFunction();
        expectTypeOf(ctx.channel.broadcast).toBeFunction();
        expectTypeOf(ctx.channel.members).toBeFunction();
        expectTypeOf(ctx.request).toBeFunction();
        expectTypeOf(ctx.broadcastRequest).toBeFunction();
        expectTypeOf(ctx.tags.ephemeral('role').broadcastRequest).toBeFunction();
        // @ts-expect-error — stream generators have their own ctx, not a gate ctx.
        ctx.stream;
        expectTypeOf(ctx.channels.get('request-gated').broadcastRequest).toBeFunction();
      },
      commit(ctx) {
        // @ts-expect-error — channel request methods are not part of gate ctx.
        ctx.channel.request;
        // @ts-expect-error — channel request methods are not part of gate ctx.
        ctx.channel.broadcastRequest;
      },
      revalidate(ctx) {
        // @ts-expect-error — channel request methods are not part of gate ctx.
        ctx.channel.request;
        // @ts-expect-error — channel request methods are not part of gate ctx.
        ctx.channel.broadcastRequest;
      },
    });

    const normal = requestGateBase.channel('request-normal', {
      capabilities: [
        serverRequests({
          ask: { out: t<{ prompt: string }>(), in: v.object({ ok: v.boolean() }) },
        }),
      ],
    });
    normal.on('message', {
      run(ctx) {
        expectTypeOf(ctx.channel.request).toBeFunction();
        expectTypeOf(ctx.channel.broadcastRequest).toBeFunction();
      },
    });
    normal.subscribe((ctx) => {
      expectTypeOf(ctx.channel.request).toBeFunction();
      expectTypeOf(ctx.channel.broadcastRequest).toBeFunction();
    });
    normal.unsubscribe((ctx) => {
      expectTypeOf(ctx.channel.request).toBeFunction();
      expectTypeOf(ctx.channel.broadcastRequest).toBeFunction();
    });
    normal.sessionEnd((ctx) => {
      expectTypeOf(ctx.channel.request).toBeFunction();
      expectTypeOf(ctx.channel.broadcastRequest).toBeFunction();
    });
  });

  it('keeps replay channel-scoped instead of exposing the root replay method', () => {
    const replayBase = define({
      env: t<Env>(),
      capabilities: [channels(), replay.history()],
    });
    replayBase.channel('replay-gated', {
      check(ctx) {
        // The channel handle owns replay for channel-scoped contexts. The
        // root replay method is only for non-channel handlers.
        // @ts-expect-error — channel gate contexts do not expose root replay.
        ctx.sendReplay;
        expectTypeOf(ctx.channel.sendReplay).not.toBeAny();
      },
    });
  });
});
