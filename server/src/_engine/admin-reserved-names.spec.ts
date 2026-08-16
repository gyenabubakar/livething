import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import type { AsyncContextFactory } from '~/context.ts';

function passthroughAsyncContext(): AsyncContextFactory {
  return function createAsyncContext<TStore>() {
    let current: TStore | undefined;
    return {
      run<R>(store: TStore, callback: () => R): R {
        const prev = current;
        current = store;
        try {
          return callback();
        } finally {
          current = prev;
        }
      },
      getStore: () => current,
    };
  };
}

function engineWithApi(makeApi: (ctx: unknown) => object) {
  const base = define({ env: t<Record<string, never>>(), capabilities: [] });
  const handler = base.assemble({ handlers: [], api: makeApi as never });
  let created: unknown;
  const build = adapter<Record<string, never>, unknown>({
    id: 'probe',
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      created = createEngine({
        env: {},
        platform: {},
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: {
          setAlarm: async () => {},
          deleteAlarm: async () => {},
          getAlarm: async () => null,
        },
        waitUntil: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      return created;
    },
  });
  build(handler as never, {});
  return created as { initialize(): Promise<void>; admin(): unknown };
}

describe('VERIFY · reserved admin api names fail at boot', () => {
  it("rejects 'then' during initialize, not on the first admin() call", async () => {
    const engine = engineWithApi(() => ({ then: () => 'hijacked' }));
    await expect(engine.initialize()).rejects.toThrow(/then/);
  });

  it("rejects '__proto__', which would rewrite the prototype instead of adding a method", async () => {
    const engine = engineWithApi(() =>
      Object.defineProperty({}, '__proto__', {
        value: () => 'nope',
        enumerable: true,
        configurable: true,
        writable: true,
      }),
    );
    await expect(engine.initialize()).rejects.toThrow(/__proto__/);
  });

  it('an ordinary api method still boots and stays callable', async () => {
    const engine = engineWithApi(() => ({ ping: () => 'pong' }));
    await expect(engine.initialize()).resolves.toBeUndefined();
    const admin = engine.admin() as { ping(): string };
    expect(admin.ping()).toBe('pong');
  });
});
