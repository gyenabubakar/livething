import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { listMembershipsByUser } from '~/channel/storage.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { StorageProvider } from '~/context.ts';

type Frame = [string, Record<string, unknown> | null, Record<string, unknown> | null];

function buildEngine(storage: StorageProvider, membership: 'persistent' | 'ephemeral'): Engine {
  const base = server({ authenticate: () => ({}), capabilities: [channels()] });
  const rooms = base.channel(['rooms', 'room:{roomId}'], { membership });
  const markRead = rooms.on('mark-read', { run() {} });
  // Stays persistent, so the server still runs auto-rejoin after the change.
  const teams = base.channel(['teams', 'team:{teamId}'], { membership: 'persistent' });
  const pinTeam = teams.on('pin-team', { run() {} });

  let engine!: Engine;
  adapter({
    id: 'rejoin-membership-change-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage,
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(base.assemble({ handlers: [markRead, pinTeam] }), {} as never);

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
    async subscribe() {
      await handle.handleMessage(JSON.stringify(['__subscribe__', null, general]));
      await vi.advanceTimersByTimeAsync(0);
    },
    async close() {
      await handle.handleClose(1000, '');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a channel that stops being persistent between deploys', () => {
  it('loses its stored rows at boot, so a reconnect does not rejoin it', async () => {
    const storage = createTestStorage();

    const before = buildEngine(storage, 'persistent');
    await before.initialize();

    const ada = await connect(before, 'ada');
    await ada.subscribe();
    await ada.close();
    expect(listMembershipsByUser(storage.sql, 'ada')).toHaveLength(1);

    const after = buildEngine(storage, 'ephemeral');
    await after.initialize();

    const bob = await connect(after, 'bob');
    await bob.subscribe();
    await vi.advanceTimersByTimeAsync(5000);
    const bobFramesBefore = bob.frames.length;

    const adaAgain = await connect(after, 'ada');
    await vi.advanceTimersByTimeAsync(5000);

    expect(adaAgain.frames.map(([event]) => event)).toEqual(['__connected__']);
    expect(bob.frames.slice(bobFramesBefore)).toEqual([]);
    expect(listMembershipsByUser(storage.sql, 'ada')).toHaveLength(0);
  });
});
