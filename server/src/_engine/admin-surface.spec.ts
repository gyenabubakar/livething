import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestSql } from '~/_test/sql.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { AsyncContextFactory, KVProvider } from '~/context.ts';

function memoryKV(): KVProvider {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  } as unknown as KVProvider;
}

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
        storage: { sql: createTestSql(), kv: memoryKV() },
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
});
