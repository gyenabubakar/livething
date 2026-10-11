import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

function buildEngine(error: (...args: unknown[]) => void): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'transport-error-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error },
      });
      return {};
    },
  });
  const base = server({});
  runAdapter(base.assemble({ handlers: [] }), undefined as never);

  return captured!;
}

describe('a socket error that no handler caused', () => {
  it('is not logged as an error that a handler threw', async () => {
    const error = vi.fn();
    const engine = buildEngine(error);
    await engine.initialize();
    const handle = engine.accept(Symbol('alice'), {
      send() {},
      close() {},
      bufferedAmount: () => 0,
      userId: 'alice',
    } as never);

    await handle.handleError(new Error('read ECONNRESET'));

    const messages = error.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((message) => /handler threw/i.test(message))).toEqual([]);
  });
});
