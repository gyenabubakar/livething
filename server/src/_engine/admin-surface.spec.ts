import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
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
  const base = define({ env: t<Record<string, never>>(), capabilities: [] });
  const noop = base.on('noop', { input: v.object({}), run() {} });
  const handler = base.assemble({ handlers: [noop], api: makeApi });

  let engine!: Engine<object>;
  const server = adapter({
    id: 'test',
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      engine = createEngine({
        env: {},
        platform: { kind: 'test' },
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: {
          setAlarm: vi.fn(async () => {}),
          deleteAlarm: vi.fn(async () => {}),
          getAlarm: vi.fn(async () => null),
        },
        waitUntil: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }) as Engine<object>;
      return {};
    },
  });
  server(handler, {} as never);
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

  // These names belong to JavaScript, not to WSKit. Rejecting them in the engine
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

    it('leaves an ordinary api method alone', () => {
      const engine = buildEngine(() => ({ thenSomething: () => 'ok' }));

      expect((engine.admin() as unknown as { thenSomething(): string }).thenSomething()).toBe('ok');
    });
  });
});
