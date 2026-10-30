import { LiveThingConfigError } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
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

/** Build an engine whose `api` factory returns whatever the test hands back. */
function buildEngine(makeApi: (ctx: unknown) => object): Engine<object> {
  const base = server({ capabilities: [] });
  const noop = base.on('noop', { input: v.object({}), run() {} });
  const definition = base.assemble({ handlers: [noop], api: makeApi });

  let engine!: Engine<object>;
  const runAdapter = adapter({
    id: 'test',
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      engine = createEngine({
        platform: { kind: 'test' },
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: {
          setAlarm: vi.fn(async () => {}),
          deleteAlarm: vi.fn(async () => {}),
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }) as Engine<object>;
      return {};
    },
  });
  runAdapter(definition, {} as never);

  return engine;
}

describe('Engine.admin() surfacing the app api', () => {
  it('surfaces methods an object-literal api returns', () => {
    const engine = buildEngine(() => ({
      archiveRoom: (room: string) => `archived:${room}`,
    }));

    const admin = engine.admin() as unknown as { archiveRoom(room: string): string };
    expect(admin.archiveRoom('r42')).toBe('archived:r42');
  });

  it('surfaces prototype methods of a class-instance api, receiver intact', () => {
    class AdminApi {
      readonly #label = 'archived';
      archiveRoom(room: string): string {
        return `${this.#label}:${room}`;
      }
    }

    const engine = buildEngine(() => new AdminApi());

    const admin = engine.admin() as unknown as { archiveRoom(room: string): string };
    // Calling through the merged surface must not rebind away from the instance,
    // or reading the private field throws.
    expect(admin.archiveRoom('r42')).toBe('archived:r42');
  });

  it('prefers an own api member over a same-named prototype member', () => {
    const inherited = {
      report(): string {
        return 'prototype';
      },
    };

    const api = Object.assign(Object.create(inherited), {
      report: () => 'own',
    });
    const engine = buildEngine(() => api);

    expect((engine.admin() as unknown as { report(): string }).report()).toBe('own');
  });

  it('keeps a built-in when an api method of the same name is returned', () => {
    const rogue = vi.fn();
    const engine = buildEngine(() => ({ broadcast: rogue }));

    const admin = engine.admin();
    admin.broadcast('evt', { n: 1 });

    expect(rogue).not.toHaveBeenCalled();
  });

  it('leaves connectionCount live rather than freezing it at build time', () => {
    const engine = buildEngine(() => ({}));

    expect(engine.admin().connectionCount).toBe(0);
  });

  // These names belong to JavaScript, not to LiveThing. Rejecting them in the engine
  // means every adapter inherits the rule instead of restating it.
  describe('reserved api method names', () => {
    it("refuses 'then', which would make awaiting the admin surface hang forever", () => {
      const engine = buildEngine(() => ({ then: vi.fn() }));

      expect(() => engine.admin()).toThrow(/then/);
    });

    it("refuses '__proto__', which would rewrite the prototype instead of adding a method", () => {
      const engine = buildEngine(() => ({ ['__proto__']: vi.fn() }));

      expect(() => engine.admin()).toThrow(/__proto__/);
    });

    it('rejects a reserved name reached through the prototype chain, not just an own one', () => {
      class Api {
        then() {
          return 'nope';
        }
      }

      const engine = buildEngine(() => new Api());

      expect(() => engine.admin()).toThrow(/then/);
    });

    it('rejects an app-defined constructor reached through a custom prototype', () => {
      const prototype = Object.create(null) as Record<string, unknown>;
      prototype.constructor = vi.fn();
      const api = Object.create(prototype) as Record<string, unknown>;
      const engine = buildEngine(() => api);

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(() => engine.admin()).toThrow(/constructor/);
    });

    it('rejects an own constructor on a null-prototype api', () => {
      const api = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(api, 'constructor', {
        value: vi.fn(),
        enumerable: true,
      });
      const engine = buildEngine(() => api);

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(() => engine.admin()).toThrow(/constructor/);
    });

    it('rejects an own constructor even when its prototype points back to the api', () => {
      const api = Object.create(null) as Record<string, unknown>;
      function AppConstructor() {}

      AppConstructor.prototype = api;
      Object.defineProperty(api, 'constructor', {
        value: AppConstructor,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      const engine = buildEngine(() => api);

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(() => engine.admin()).toThrow(/constructor/);
    });

    it("does not execute a constructor function's prototype getter while rejecting it", () => {
      const api = Object.create(null) as Record<string, unknown>;
      let reads = 0;
      const AppConstructor = new Proxy(function AppConstructor() {}, {
        get: (target, key, receiver) => {
          if (key === 'prototype') {
            reads += 1;
            return api;
          }

          return Reflect.get(target, key, receiver);
        },
      });
      Object.defineProperty(api, 'constructor', {
        value: AppConstructor,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      const engine = buildEngine(() => api);

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(reads).toBe(0);
    });

    it('rejects an inherited constructor-shaped object', () => {
      const prototype = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(prototype, 'constructor', {
        value: { prototype },
        writable: true,
        enumerable: false,
        configurable: true,
      });
      const engine = buildEngine(() => Object.create(prototype));

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(() => engine.admin()).toThrow(/constructor/);
    });

    it('rejects a function marker forged on a null-prototype custom prototype', () => {
      const prototype = Object.create(null) as Record<string, unknown>;
      function AppConstructor() {}

      AppConstructor.prototype = prototype;
      Object.defineProperty(prototype, 'constructor', {
        value: AppConstructor,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      const engine = buildEngine(() => Object.create(prototype));

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(() => engine.admin()).toThrow(/constructor/);
    });

    it('rejects an inherited bound constructor', () => {
      const prototype = Object.create(null) as Record<string, unknown>;
      function AppConstructor() {}

      Object.defineProperty(prototype, 'constructor', {
        value: AppConstructor.bind(null),
        writable: true,
        enumerable: false,
        configurable: true,
      });
      const engine = buildEngine(() => Object.create(prototype));

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(() => engine.admin()).toThrow(/constructor/);
    });

    it('rejects an inherited constructor accessor without invoking it', () => {
      const prototype = Object.create(null) as Record<string, unknown>;
      let reads = 0;
      Object.defineProperty(prototype, 'constructor', {
        get: () => {
          reads += 1;
          return () => 'app-defined';
        },
        configurable: true,
      });
      const engine = buildEngine(() => Object.create(prototype));

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(reads).toBe(0);
    });

    it('rejects a constructor reported by a proxy without reading the app value', () => {
      const target = Object.create(null) as Record<string, unknown>;
      let reads = 0;
      const api = new Proxy(target, {
        ownKeys: () => ['constructor'],
        getOwnPropertyDescriptor: () => ({
          value: () => 'app-defined',
          writable: true,
          enumerable: true,
          configurable: true,
        }),
        get: () => {
          reads += 1;
          return undefined;
        },
      });
      const engine = buildEngine(() => api);

      expect(() => engine.admin()).toThrow(LiveThingConfigError);
      expect(reads).toBe(0);
    });

    it('ignores symbol members because the admin surface exposes string methods', () => {
      const hidden = Symbol('hidden');
      const api = Object.assign(Object.create(null), { ping: () => 'pong' }) as Record<
        string | symbol,
        unknown
      >;
      api[hidden] = () => 'not exposed';
      const engine = buildEngine(() => api as Record<string, unknown>);

      const admin = engine.admin() as unknown as { ping(): string };
      expect(admin.ping()).toBe('pong');
      expect(hidden in (admin as object)).toBe(false);
    });

    it('leaves an ordinary api method alone', () => {
      const engine = buildEngine(() => ({ thenSomething: () => 'ok' }));

      expect((engine.admin() as unknown as { thenSomething(): string }).thenSomething()).toBe('ok');
    });
  });
});
