import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { dispatchRuntime, outgoingRuntime } from '~/_engine/engine.deps.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { bench, describe } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function makeCore(): EngineCore {
  let core: EngineCore | undefined;
  const runAdapter = adapter({
    id: 'bench',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      core = createEngine({
        storage: createTestStorage(),

        platform: {},
        timers: {
          setAlarm: async () => {},
          deleteAlarm: async () => {},
          getAlarm: async () => null,
        },
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      }).core;
      return {};
    },
  });
  runAdapter({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
  return core!;
}

const core = makeCore();

describe('engine.deps bag construction', () => {
  // dispatchRuntime is rebuilt on every inbound message; outgoingRuntime on
  // every send. Memoized, each call is a WeakMap lookup.
  bench('dispatchRuntime(core) — per inbound message', () => {
    dispatchRuntime(core);
  });

  bench('outgoingRuntime(core) — per send', () => {
    outgoingRuntime(core);
  });
});
