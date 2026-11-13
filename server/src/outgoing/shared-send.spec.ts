import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { sequence } from '~/sequence/capability.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { AsyncContextFactory } from '~/context.ts';
import type { OutgoingFrame } from '~/intercept/intercept.ts';

function passthroughAsyncContext(): AsyncContextFactory {
  return function createAsyncContext<TStore>() {
    let current: TStore | undefined;
    return {
      run<R>(store: TStore, callback: () => R): R {
        const previous = current;
        current = store;
        try {
          return callback();
        } finally {
          current = previous;
        }
      },
      getStore: () => current,
    };
  };
}

function buildEngine(seen: OutgoingFrame[]): Engine {
  const base = server({
    upgrade: () => ({ userId: 'unused' }),
    capabilities: [
      sequence(),
      dedup(),
      tags((ephemeral) => [ephemeral('team')]),
      emits({ note: t<{ text: string }>() }),
    ],
    onOutgoing(_ctx, frame) {
      seen.push(frame);
    },
  });

  const joinTeam = base.on('join-team', {
    run(ctx) {
      ctx.tags.ephemeral('team').add('eng');
    },
  });
  const noteTeam = base.on('note-team', {
    run(ctx) {
      ctx.tags.ephemeral('team').ref('eng').broadcast('note', { text: 'standup in 5' });
    },
  });
  const noteEveryone = base.on('note-everyone', {
    run(ctx) {
      ctx.broadcast('note', { text: 'deploy done' }, { includeSelf: true });
    },
  });
  const definition = base.assemble({ handlers: [joinTeam, noteTeam, noteEveryone] });

  let engine!: Engine;
  adapter({
    id: 'test',
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(definition, {} as never);

  return engine;
}

async function connect(engine: Engine, userId: string) {
  const frames: string[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: ({ text }: { kind: 'text'; text: string }) => void frames.push(text),
    close: () => {},
    bufferedAmount: () => 0,
    userId,
  });
  await Promise.resolve();

  return {
    frames,
    async send(event: string) {
      await handle.handleMessage(JSON.stringify([event, {}, null]));
    },
    notes: () => frames.filter((frame) => JSON.parse(frame)[0] === 'note'),
  };
}

describe('a send to many connections is one frame', () => {
  it('gives every tag member the same frame and shows the send to onOutgoing once', async () => {
    const seen: OutgoingFrame[] = [];
    const engine = buildEngine(seen);
    await engine.initialize();

    const ada = await connect(engine, 'ada');
    const ben = await connect(engine, 'ben');
    const cleo = await connect(engine, 'cleo');

    await ada.send('join-team');
    await ben.send('join-team');

    await ada.send('note-team');

    expect(ada.notes()).toHaveLength(1);
    expect(ben.notes()).toEqual(ada.notes());
    expect(cleo.notes()).toEqual([]);
    expect(JSON.parse(ada.notes()[0]!)[2]).toMatchObject({
      delivery: { seq: expect.any(Number), id: expect.any(String) },
    });
    expect(seen).toEqual([
      expect.objectContaining({
        event: 'note',
        payload: { text: 'standup in 5' },
        target: { kind: 'tag', tagKind: 'ephemeral', group: 'team', key: 'eng' },
        recipients: 2,
      }),
    ]);
  });

  it('gives every connection the same broadcast frame', async () => {
    const seen: OutgoingFrame[] = [];
    const engine = buildEngine(seen);
    await engine.initialize();
    const ada = await connect(engine, 'ada');
    const ben = await connect(engine, 'ben');

    await ada.send('note-everyone');

    expect(ada.notes()).toHaveLength(1);
    expect(ben.notes()).toEqual(ada.notes());
    expect(seen).toEqual([expect.objectContaining({ target: { kind: 'all' }, recipients: 2 })]);
  });
});
