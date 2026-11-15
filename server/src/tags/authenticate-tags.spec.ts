import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { emits } from '~/emits/emits.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { AsyncContextFactory } from '~/context.ts';
import { tags } from './capability.ts';

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

function buildEngine(): Engine {
  const base = server({
    authenticate(request) {
      const userId = new URL(request.url).searchParams.get('user') ?? undefined;
      return userId === 'ada'
        ? { userId, tags: { ephemeral: { team: ['design', 'eng'] } } }
        : { userId };
    },
    capabilities: [
      tags((ephemeral) => [ephemeral('team', t<string>())]),
      emits({ announcement: t<{ text: string }>() }),
    ],
  });

  const announceToTeam = base.on('announce-to-team', {
    input: v.object({ team: v.string() }),
    run(ctx, { team }) {
      ctx.tags
        .ephemeral('team')
        .ref(team)
        .broadcast('announcement', { text: `hi ${team}` });
    },
  });
  const definition = base.assemble({ handlers: [announceToTeam] });

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

async function connect(engine: Engine, user: string) {
  const decision = await engine.authenticate(new Request(`https://huddle.test/?user=${user}`));
  const frames: string[] = [];
  const handle = engine.accept(Symbol(user), {
    send: ({ text }: { kind: 'text'; text: string }) => void frames.push(text),
    close: () => {},
    bufferedAmount: () => 0,
    userId: decision.userId ?? '',
    ...(decision.tags ? { tags: decision.tags } : {}),
  });
  await Promise.resolve();

  return {
    announce: (team: string) =>
      handle.handleMessage(JSON.stringify(['announce-to-team', { team }, null])),
    announcements: () =>
      frames.map((frame) => JSON.parse(frame)).filter((frame) => frame[0] === 'announcement'),
  };
}

describe('authenticate with several keys in one tag group', () => {
  it('attaches every key, so a broadcast to either ref reaches the connection', async () => {
    const engine = buildEngine();
    await engine.initialize();

    const ada = await connect(engine, 'ada');
    const ben = await connect(engine, 'ben');

    await ben.announce('design');
    await ben.announce('eng');
    await ben.announce('sales');

    expect(ada.announcements().map((frame) => frame[1])).toEqual([
      { text: 'hi design' },
      { text: 'hi eng' },
    ]);
  });
});
