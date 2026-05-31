import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { dispatchRuntime } from '~/_engine/engine.deps.ts';
import { bench, describe } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function makeCore(): EngineCore {
  let core: EngineCore | undefined;
  const server = adapter({
    id: 'bench',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      core = createEngine({
        env: {},
        platform: {},
        timers: {
          setAlarm: async () => {},
          deleteAlarm: async () => {},
          getAlarm: async () => null,
        },
        waitUntil: () => {},
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      }).core;
      return {};
    },
  });
  server({ __wskit: 'server', primitives: [] } as unknown as ServerDefinition, {} as never);
  return core!;
}

function createConnection(): RuntimeConnection {
  return {
    id: 'c1',
    identity: 'c1',
    wsKey: Symbol('c1'),
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: 'c1',
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

const buildCtx = dispatchRuntime(makeCore()).buildConnectionContext;
const connection = createConnection();

describe('buildConnectionContext', () => {
  // The common case — a handler that only touches send / payload / meta.
  bench('build — channels untouched (lazy)', () => {
    buildCtx(connection);
  });

  // Forces the deferred buildChannelsApi — what the old eager build did
  // unconditionally on every message.
  bench('build + access ctx.channels', () => {
    const ctx = buildCtx(connection) as Record<string, unknown>;
    void ctx.channels;
  });
});

// A dispatch with 3 intercepts: the old path built a fresh context for
// each intercept plus the handler (4 builds); 2a builds one and shares it.
describe('context builds for a 3-intercept dispatch', () => {
  bench('one shared context (2a)', () => {
    buildCtx(connection);
  });

  bench('a fresh context per intercept + handler (before 2a)', () => {
    for (let i = 0; i < 4; i++) {
      buildCtx(connection);
    }
  });
});
