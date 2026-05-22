import { defineServerAdapter } from '~/_adapters/define.ts';
import { dispatchRuntime, outgoingRuntime } from '~/_engine/engine.deps.ts';
import { bench, describe } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function makeCore(): EngineCore {
  let core: EngineCore | undefined;
  const serve = defineServerAdapter({
    id: 'bench',
    hibernation: { persist() {}, restore: () => undefined },
    setup(createEngine) {
      core = createEngine().core;
      return {};
    },
  });
  serve({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
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
