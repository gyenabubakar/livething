import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

function buildEngine(lookups: string[]): Engine {
  const base = server({
    authenticate: () => ({ userId: 'ada' }),
    capabilities: [serverRequests({ 'confirm-delete': { out: t<{ messageId: string }>() } })],
  });

  const markRead = base.on('mark-read', {
    run(ctx) {
      try {
        ctx.connections.get(ctx.connection);
        ctx.users.get('ada');
        lookups.push('ok');
      } catch (error) {
        lookups.push(String(error));
      }
    },
  });

  let engine!: Engine;
  adapter({
    id: 'server-requests-many-frames-spec',
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
  })(base.assemble({ handlers: [markRead] }), {} as never);

  return engine;
}

describe('serverRequests() on a long-lived connection', () => {
  it('keeps ctx.connections.get and ctx.users.get working after many frames', async () => {
    const lookups: string[] = [];
    const engine = buildEngine(lookups);
    await engine.initialize();

    const handle = engine.accept(Symbol('ada'), {
      send: () => {},
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'ada',
    });
    await Promise.resolve();

    const frame = JSON.stringify(['mark-read', {}, null]);
    const frames = 15_000;
    for (let i = 0; i < frames; i++) await handle.handleMessage(frame);

    expect(lookups).toEqual(Array.from({ length: frames }, () => 'ok'));
    // About 0.2 s on a laptop, but about 8 s on the Node 22 CI runner. The test checks
    // behaviour after many frames, not speed.
  }, 30_000);
});
