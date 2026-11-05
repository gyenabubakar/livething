import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { resetCallContextForTests } from '~/_engine/call-context.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { sequence } from '~/sequence/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

type Frame = [string, unknown, unknown];

beforeEach(() => {
  resetCallContextForTests();
});

async function start(definition: ServerDefinition) {
  const errors: unknown[][] = [];
  let engine: Engine | undefined;
  adapter({
    id: 'null-payload-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
      });
      return {};
    },
  })(definition, undefined as never);
  await engine!.initialize();

  function connect(userId: string) {
    const frames: Frame[] = [];
    const handle = engine!.accept(Symbol(userId), {
      send: ({ text }: { kind: 'text'; text: string }) => frames.push(JSON.parse(text) as Frame),
      close() {},
      bufferedAmount: () => 0,
      userId,
    } as never);
    return {
      frames,
      send: (frame: Frame) => handle.handleMessage(JSON.stringify(frame)),
    };
  }

  return { connect, errors };
}

describe('a null payload', () => {
  it('is sent as null by ctx.send and ctx.broadcast', async () => {
    const base = server({
      capabilities: [emits({ 'notifications-cleared': t<null>(), 'room-cleared': t<null>() })],
    });
    const clear = base.on('clear-notifications', {
      input: v.null(),
      run(ctx, input) {
        expect(input).toBeNull();
        ctx.send('notifications-cleared', null);
        ctx.broadcast('room-cleared', null);
      },
    });
    const { connect, errors } = await start(base.assemble({ handlers: [clear] }));
    const alice = connect('alice');
    const bob = connect('bob');

    await alice.send(['clear-notifications', null, null]);

    await vi.waitFor(() =>
      expect(alice.frames).toContainEqual(['notifications-cleared', null, null]),
    );
    await vi.waitFor(() =>
      expect(bob.frames.find(([event]) => event === 'room-cleared')?.[1]).toBeNull(),
    );
    expect(errors).toEqual([]);
  });

  it('is sent as null when a stream yields it', async () => {
    const base = server({ capabilities: [stream()] });
    const ticks = base.stream('ticks', {
      async *run() {
        yield null;
      },
    });
    const { connect, errors } = await start(base.assemble({ handlers: [ticks] }));
    const alice = connect('alice');

    await alice.send(['ticks', null, { stream: { id: 's1' } }]);

    await vi.waitFor(() => expect(alice.frames.map(([event]) => event)).toContain('__streamEnd__'));
    expect(alice.frames.find(([event]) => event === 'ticks')?.[1]).toBeNull();
    expect(errors).toEqual([]);
  });

  it('is sent as null by ctx.request', async () => {
    const base = server({
      capabilities: [serverRequests({ 'confirm-leave': { out: t<null>(), in: v.boolean() } })],
    });
    const leave = base.on('leave', {
      run(ctx) {
        ctx.request('confirm-leave', null).catch(() => {});
      },
    });
    const { connect } = await start(base.assemble({ handlers: [leave] }));
    const alice = connect('alice');

    await alice.send(['leave', null, null]);

    await vi.waitFor(() =>
      expect(alice.frames.find(([event]) => event === 'confirm-leave')?.[1]).toBeNull(),
    );
  });

  it('is sent as null by a channel broadcast', async () => {
    const base = server({ capabilities: [channels()] });
    const general = base.channel('general', {
      capabilities: [emits({ 'topic-cleared': t<null>() })],
    });
    const clearTopic = general.on('clear-topic', {
      run(ctx) {
        ctx.channel.broadcast('topic-cleared', null, { includeSelf: true });
      },
    });
    const { connect, errors } = await start(base.assemble({ handlers: [general, clearTopic] }));
    const alice = connect('alice');

    const channel = { channel: { name: 'general' } };

    await alice.send(['__subscribe__', null, channel]);
    await alice.send(['clear-topic', null, channel]);

    await vi.waitFor(() =>
      expect(alice.frames.find(([event]) => event === 'topic-cleared')?.[1]).toBeNull(),
    );
    expect(errors).toEqual([]);
  });

  it('is stored and replayed as null', async () => {
    const base = server({
      capabilities: [
        emits({ 'notifications-cleared': t<null>() }),
        dedup(),
        sequence({ persist: true }),
        replay.history(),
      ],
    });
    const clear = base.on('clear-notifications', {
      run(ctx) {
        ctx.broadcast('notifications-cleared', null, { includeSelf: true });
      },
    });
    const { connect, errors } = await start(base.assemble({ handlers: [clear] }));
    await connect('alice').send(['clear-notifications', null, null]);

    const bob = connect('bob');
    await bob.send(['__replay__', { lastKnownSeq: 0 }, null]);

    await vi.waitFor(() =>
      expect(bob.frames.find(([event]) => event === 'notifications-cleared')?.[1]).toBeNull(),
    );
    expect(errors).toEqual([]);
  });

  it('is still refused when it is a string, a number or an array', async () => {
    const base = server({ capabilities: [emits({ 'notifications-cleared': t<null>() })] });
    const refused: string[] = [];
    const send = base.on('send-bad', {
      input: v.unknown(),
      run(ctx, input) {
        try {
          ctx.send('notifications-cleared', input as null);
        } catch (error) {
          refused.push((error as Error).message);
        }
      },
    });
    const { connect } = await start(base.assemble({ handlers: [send] }));
    const alice = connect('alice');

    for (const bad of ['text', 42, [1]]) await alice.send(['send-bad', bad, null]);

    expect(refused).toHaveLength(3);
    for (const message of refused) {
      expect(message).toMatch(/must be a plain object, such as \{ text: 'hi' \}, or null/);
    }

    expect(alice.frames.map(([event]) => event)).not.toContain('notifications-cleared');
  });
});
