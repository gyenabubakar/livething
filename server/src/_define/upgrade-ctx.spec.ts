import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { InitContext } from '~/context.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { plugin } from './plugins.ts';

function buildEngine(definition: ServerDefinition, platform: unknown = {}): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'upgrade-ctx',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform,
        timers: { setAlarm() {}, getAlarm: () => null, deleteAlarm() {} } as never,
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

describe('upgrade(request, ctx)', () => {
  it('reads tables created in onInit and decides userId and meta from them', async () => {
    const base = server({
      upgrade: (request, ctx) => {
        const token = new URL(request.url).searchParams.get('token');
        const session = ctx.sql
          .exec<{
            userId: string;
            role: string;
          }>('SELECT userId, role FROM sessions WHERE token = ?', token)
          .one();

        return { userId: session?.userId, meta: { role: session?.role ?? 'guest' } };
      },
    });
    base.onInit((ctx) => {
      ctx.sql.exec('CREATE TABLE sessions (token TEXT, userId TEXT, role TEXT)');
      ctx.sql.exec("INSERT INTO sessions VALUES ('abc', 'user-1', 'admin')");
    });

    const engine = buildEngine(base.assemble({ handlers: [] }));
    await engine.initialize();

    const known = await engine.handleUpgrade(new Request('https://x/?token=abc'));
    expect(known.userId).toBe('user-1');
    expect(known.meta).toEqual({ role: 'admin' });

    const unknown = await engine.handleUpgrade(new Request('https://x/?token=nope'));
    expect(unknown.meta).toEqual({ role: 'guest' });
  });

  it('gives the upgrade the kv store, logger and platform', async () => {
    const platform = { name: 'test-platform' };
    let seen: InitContext | undefined;
    const base = server({
      upgrade: (_request, ctx) => {
        seen = ctx;
        return { userId: 'u1' };
      },
    });

    const engine = buildEngine(base.assemble({ handlers: [] }), platform);
    await engine.initialize();
    await engine.handleUpgrade(new Request('https://x/'));

    expect(seen?.platform).toBe(platform);
    expect(typeof seen?.log.info).toBe('function');
    expect(typeof seen?.kv.get).toBe('function');
    expect(typeof seen?.sql.transaction).toBe('function');
  });

  it('does not give a plugin upgrade the app storage', async () => {
    let received: unknown[] = [];
    const scoped = server({
      scope: 'plugin',
      upgrade: (...args: [Request]) => {
        received = args;
        return { userId: 'u1' };
      },
    });
    const go = scoped.on('go', { run() {} });
    const { __primitives } = plugin('acme:auth', {
      definition: scoped.assemble({ handlers: [go] }),
    })();
    const upgradePrimitive = __primitives.find(
      (primitive) => primitive.__livething === 'onUpgrade',
    ) as unknown as { handler: (request: Request, helpers: unknown) => Promise<unknown> };

    await upgradePrimitive.handler(new Request('https://x'), { ctx: { sql: 'app storage' } });

    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(Request);
  });
});
