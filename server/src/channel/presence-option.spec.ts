import { AsyncLocalStorage } from 'node:async_hooks';
import { LiveThingConfigError } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

type Frame = [string, Record<string, unknown> | null, Record<string, unknown> | null];

function buildEngine(roomOptions: Record<string, unknown> = {}): Engine {
  const base = server({
    authenticate: () => ({}),
    capabilities: [
      channels(),
      dedup(),
      sequence({ persist: true }),
      replay.history(),
      emits({ 'room-size': t<{ size: number }>() }),
    ],
  });

  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    membership: 'persistent',
    ...roomOptions,
    capabilities: [emits({ message: t<{ text: string }>() })],
  });

  const sendMessage = rooms.on('send-message', {
    run(ctx) {
      ctx.channel.broadcast('message', { text: 'hello' }, { includeSelf: true });
    },
  });

  // Sends an old message again, to the caller only.
  const resendMessage = rooms.on('resend-message', {
    run(ctx) {
      ctx.channel.sendReplay?.(
        'message',
        { text: 'earlier' },
        { deliverySeq: 1, messageId: 'm-1' },
      );
    },
  });

  const countMembers = rooms.on('count-members', {
    run(ctx) {
      ctx.send('room-size', { size: ctx.channel.memberCount() });
    },
  });

  let engine!: Engine;
  adapter({
    id: 'presence-option-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(base.assemble({ handlers: [sendMessage, resendMessage, countMembers] }), {} as never);

  return engine;
}

const general = { channel: { name: 'room:general', family: 'rooms' } };

async function connect(engine: Engine, userId: string) {
  const frames: Frame[] = [];
  const handle = engine.accept(Symbol(userId), {
    send(frame: { kind: string; text?: string }) {
      if (frame.kind === 'text') frames.push(JSON.parse(frame.text!) as Frame);
    },
    close: () => {},
    bufferedAmount: () => 0,
    userId,
  });
  await vi.advanceTimersByTimeAsync(0);

  return {
    frames,
    events: () => frames.map(([event]) => event).filter((event) => event !== '__connected__'),
    changes: () =>
      frames
        .filter(([event]) => event === '__memberChanges__')
        .flatMap(([, payload]) =>
          (payload!.changes as { kind: string; memberId: string }[]).map(
            ({ kind, memberId }) => `${kind} ${memberId}`,
          ),
        ),
    async send(event: string) {
      await handle.handleMessage(JSON.stringify([event, null, general]));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

/** Let every open presence window end. */
async function quiet(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('channel presence', () => {
  it('sends a member sync to the joiner and the join to the others at once', async () => {
    const engine = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');

    await alice.send('__subscribe__');
    await quiet();
    await bob.send('__subscribe__');

    expect(bob.events()).toEqual(['__subscribeOk__', '__memberSync__']);
    expect(alice.changes()).toEqual(['join bob', 'online bob']);
  });

  it('holds changes that come during the window and sends them when it ends', async () => {
    const engine = buildEngine({ presence: { windowMs: 200 } });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    const carol = await connect(engine, 'carol');

    await alice.send('__subscribe__');
    await quiet();

    await bob.send('__subscribe__');
    await carol.send('__subscribe__');
    expect(alice.changes()).toEqual(['join bob', 'online bob']);

    await vi.advanceTimersByTimeAsync(199);
    expect(alice.changes()).toEqual(['join bob', 'online bob']);

    await vi.advanceTimersByTimeAsync(1);
    expect(alice.changes()).toEqual(['join bob', 'online bob', 'join carol', 'online carol']);
    expect(bob.changes()).toEqual(['join carol', 'online carol']);
    expect(carol.changes()).toEqual([]);
  });

  it('sends the waiting changes before a channel message', async () => {
    const engine = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    const carol = await connect(engine, 'carol');

    await alice.send('__subscribe__');
    await quiet();
    await bob.send('__subscribe__');
    alice.frames.length = 0;

    await carol.send('__subscribe__');
    await carol.send('send-message');

    expect(alice.events()).toEqual(['__memberChanges__', 'message']);
    expect(alice.changes()).toEqual(['join carol', 'online carol']);
  });

  it('sends the waiting changes before a replayed channel message', async () => {
    const engine = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    const carol = await connect(engine, 'carol');

    await alice.send('__subscribe__');
    await quiet();
    await bob.send('__subscribe__');
    alice.frames.length = 0;

    await carol.send('__subscribe__');
    await alice.send('resend-message');

    expect(alice.events()).toEqual(['__memberChanges__', 'message']);
  });

  it('sends a change at once after a join that added none on a quiet channel', async () => {
    const engine = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    const bobSecondTab = await connect(engine, 'bob');

    const carol = await connect(engine, 'carol');
    await alice.send('__subscribe__');
    await bob.send('__subscribe__');
    await quiet();
    alice.frames.length = 0;

    await bobSecondTab.send('__subscribe__');
    await carol.send('__subscribe__');

    expect(alice.changes()).toEqual(['join carol', 'online carol']);
  });

  it('sends no presence on a channel with presence: false', async () => {
    const engine = buildEngine({ presence: false });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');

    await alice.send('__subscribe__');
    await bob.send('__subscribe__');
    await quiet();

    expect(alice.events()).toEqual(['__subscribeOk__']);
    expect(bob.events()).toEqual(['__subscribeOk__']);
  });

  it('counts the channel members with memberCount()', async () => {
    const engine = buildEngine({ presence: false });
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.send('__subscribe__');

    await bob.send('__subscribe__');

    await alice.send('count-members');

    expect(alice.frames.at(-1)?.slice(0, 2)).toEqual(['room-size', { size: 2 }]);
  });

  it('drops a waiting batch and its timer on shutdown', async () => {
    const engine = buildEngine();
    await engine.initialize();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    const carol = await connect(engine, 'carol');

    await alice.send('__subscribe__');
    await bob.send('__subscribe__');
    await carol.send('__subscribe__');
    const timersBefore = vi.getTimerCount();

    await engine.handleShutdown();

    expect(vi.getTimerCount()).toBeLessThan(timersBefore);
    await expect(quiet()).resolves.toBeUndefined();
  });

  it.each([
    ['a string', 'yes'],
    ['a zero window', { windowMs: 0 }],
    ['a negative window', { windowMs: -5 }],
    ['a fractional window', { windowMs: 1.5 }],
    ['an unknown key', { delayMs: 100 }],
    ['a window longer than a timer can hold', { windowMs: 2 ** 31 }],
  ])('refuses %s as the presence option', (_case, presence) => {
    expect(() => buildEngine({ presence })).toThrow(LiveThingConfigError);
  });
});
