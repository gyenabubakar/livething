import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { connectionCall, createAsyncContext, inConnectionCall } from '~/_engine/async-context.ts';
import { getCurrentCall, resetCallContextForTests } from '~/_engine/call-context.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { context } from '~/ambient-context.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

beforeEach(() => resetCallContextForTests());

describe('inConnectionCall', () => {
  function generatorParkedAtYield(seen: { kind?: string }) {
    const generator = (async function* () {
      try {
        yield 1;
        yield 2;
      } finally {
        seen.kind = getCurrentCall()?.kind ?? 'no call';
      }
    })();

    return generator;
  }

  it('runs the generator cleanup in the stream call context when return() is called from outside', async () => {
    const asyncContext = createAsyncContext(<T>() => new AsyncLocalStorage<T>());
    const call = connectionCall('connection-1', undefined, () => ({}));
    const seen: { kind?: string } = {};
    const wrapped = inConnectionCall(asyncContext, call, generatorParkedAtYield(seen));

    await wrapped.next();
    await wrapped.return(undefined);

    expect(seen.kind).toBe('connection');
  });

  it('runs the generator in the stream call context when throw() is called from outside', async () => {
    const asyncContext = createAsyncContext(<T>() => new AsyncLocalStorage<T>());
    const call = connectionCall('connection-1', undefined, () => ({}));
    const seen: { kind?: string } = {};
    const generator = (async function* () {
      try {
        yield 1;
      } catch {
        seen.kind = getCurrentCall()?.kind ?? 'no call';
      }
    })();
    const wrapped = inConnectionCall(asyncContext, call, generator);

    await wrapped.next();
    await wrapped.throw(new Error('buffer full'));

    expect(seen.kind).toBe('connection');
  });
});

function buildEngine(definition: ServerDefinition): Engine {
  let captured: Engine | undefined;
  adapter({
    id: 'stream-cleanup-context-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A stream iterator that stays parked at a yield while its consumer is slow. */
function slowConsumerIterator(inner: AsyncGenerator<unknown, void, unknown>) {
  let first = true;

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(value: unknown) {
      const result = await inner.next(value);
      if (first) {
        first = false;
        await sleep(200);
      }

      return result;
    },
    return: (value: unknown) => inner.return(value as never),
    throw: (error: unknown) => inner.throw(error),
  };
}

function userInCleanup(base: Parameters<typeof context.connection>[0]): string {
  try {
    return context.connection(base).user.id;
  } catch (error) {
    return `threw: ${(error as Error).message.slice(0, 60)}`;
  }
}

const CANCEL_FRAME = JSON.stringify(['__streamCancel__', null, { stream: { id: 's1' } }]);

describe('context.* in the finally block of a stream that is cancelled while parked at a yield', () => {
  it('works for an ephemeral stream', async () => {
    const base = server({ capabilities: [stream()] });
    const seen: { user?: string } = {};
    const feed = base.stream('feed', {
      run() {
        return slowConsumerIterator(
          (async function* () {
            try {
              yield { n: 1 };
              yield { n: 2 };
            } finally {
              seen.user = userInCleanup(base);
            }
          })(),
        ) as never;
      },
    } as never);
    const engine = buildEngine(base.assemble({ handlers: [feed] }));
    await engine.initialize();

    const connection = engine.accept(Symbol('alice'), {
      send() {},
      close() {},
      bufferedAmount: () => 0,
      userId: 'alice',
    } as never);

    void connection.handleMessage(JSON.stringify(['feed', {}, { stream: { id: 's1' } }]));
    await sleep(30);
    await connection.handleMessage(CANCEL_FRAME);
    await sleep(30);

    expect(seen.user).toBe('alice');
  });

  it('works for a durable stream', async () => {
    const base = server({ capabilities: [recordedStream()] });
    const seen: { user?: string } = {};
    const feed = base.recordedStream('feed', {
      input: v.object({}),
      maxChunks: 100,
      run() {
        return slowConsumerIterator(
          (async function* () {
            try {
              yield { n: 1 };
              yield { n: 2 };
            } finally {
              seen.user = userInCleanup(base);
            }
          })(),
        ) as never;
      },
    } as never);
    const engine = buildEngine(base.assemble({ handlers: [feed] }));
    await engine.initialize();

    const connection = engine.accept(Symbol('alice'), {
      send() {},
      close() {},
      bufferedAmount: () => 0,
      userId: 'alice',
    } as never);

    void connection.handleMessage(JSON.stringify(['feed', {}, { stream: { id: 's1' } }]));
    await sleep(30);
    await connection.handleMessage(CANCEL_FRAME);
    await sleep(30);

    expect(seen.user).toBe('alice');
  });
});
