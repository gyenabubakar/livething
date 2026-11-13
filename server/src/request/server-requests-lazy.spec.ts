import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

function buildEngine(builtSlots: string[][]): Engine {
  const base = server({
    authenticate: () => ({ userId: 'ada' }),
    capabilities: [
      channels(),
      tags((ephemeral) => [ephemeral('team')]),
      emits({ 'message-sent': t<{ text: string }>() }),
      serverRequests({ 'confirm-delete': { out: t<{ messageId: string }>() } }),
    ],
  });

  const sendMessage = base.on('send-message', {
    run(ctx) {
      ctx.send('message-sent', { text: 'hi' });
      builtSlots.push(
        Object.getOwnPropertySymbols(ctx)
          .map((symbol) => symbol.description ?? '')
          .filter((name) => name === 'livething-ctx-channels' || name === 'livething-ctx-tags'),
      );
    },
  });

  let engine!: Engine;
  adapter({
    id: 'server-requests-lazy-spec',
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
  })(base.assemble({ handlers: [sendMessage] }), {} as never);

  return engine;
}

describe('serverRequests() and the lazy ctx surfaces', () => {
  it('does not build ctx.channels or ctx.tags for a handler that only sends', async () => {
    const builtSlots: string[][] = [];
    const engine = buildEngine(builtSlots);
    await engine.initialize();

    const handle = engine.accept(Symbol('ada'), {
      send: () => {},
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'ada',
    });
    await Promise.resolve();
    await handle.handleMessage(JSON.stringify(['send-message', {}, null]));

    expect(builtSlots).toEqual([[]]);
  });
});
