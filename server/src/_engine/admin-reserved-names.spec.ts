import { LiveThingConfigError } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
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
  const base = server({ capabilities: [] });
  const definition = base.assemble({ handlers: [], api: makeApi as never });
  let created: unknown;
  const build = adapter<Record<string, never>, unknown>({
    id: 'probe',
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      created = createEngine({
        platform: {},
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: {
          setAlarm: async () => {},
          deleteAlarm: async () => {},
        },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      return created;
    },
  });
  build(definition as never, {});

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

  it("rejects an app-owned 'constructor' instead of silently dropping it", async () => {
    const engine = engineWithApi(() => ({ constructor: () => 'not-a-class-marker' }));
    const initialization = engine.initialize();
    await expect(initialization).rejects.toBeInstanceOf(LiveThingConfigError);
    await expect(initialization).rejects.toThrow(/constructor/);
  });

  it('rejects an own constructor that spoofs a prototype marker during boot', async () => {
    const api = Object.create(null) as Record<string, unknown>;
    function AppConstructor() {}

    AppConstructor.prototype = api;
    Object.defineProperty(api, 'constructor', {
      value: AppConstructor,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    const engine = engineWithApi(() => api);

    await expect(engine.initialize()).rejects.toBeInstanceOf(LiveThingConfigError);
    await expect(engine.initialize()).rejects.toThrow(/constructor/);
  });

  it('rejects an inherited app-owned constructor during public handler boot', async () => {
    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, 'constructor', {
      value: () => 'app-defined',
      enumerable: true,
    });
    const engine = engineWithApi(() => Object.create(prototype));

    const initialization = engine.initialize();
    await expect(initialization).rejects.toBeInstanceOf(LiveThingConfigError);
    await expect(initialization).rejects.toThrow(/constructor/);
  });

  it('ignores the constructor marker inherited from a class prototype', async () => {
    class AdminApi {
      ping(): string {
        return 'pong';
      }
    }

    const engine = engineWithApi(() => new AdminApi());
    await expect(engine.initialize()).resolves.toBeUndefined();
    expect((engine.admin() as { ping(): string }).ping()).toBe('pong');
  });

  it('ignores an automatic marker on a class prototype that extends null', async () => {
    class NullPrototypeApi extends null {
      constructor() {
        return Object.create(NullPrototypeApi.prototype) as NullPrototypeApi;
      }

      ping(): string {
        return 'pong';
      }
    }

    const engine = engineWithApi(() => new NullPrototypeApi());

    await expect(engine.initialize()).resolves.toBeUndefined();
    expect((engine.admin() as { ping(): string }).ping()).toBe('pong');
  });

  it('an ordinary api method still boots and stays callable', async () => {
    const engine = engineWithApi(() => ({ ping: () => 'pong' }));
    await expect(engine.initialize()).resolves.toBeUndefined();
    const admin = engine.admin() as { ping(): string };
    expect(admin.ping()).toBe('pong');
  });

  it.each([
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ])("rejects '%s' at boot instead of silently dropping the api method", async (name) => {
    const engine = engineWithApi(() => ({ [name]: () => 'app-defined' }));
    await expect(engine.initialize()).rejects.toThrow(new RegExp(name));
  });
});
