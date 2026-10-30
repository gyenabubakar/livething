import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { context } from '~/ambient-context.ts';
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
        timers: { setAlarm() {}, deleteAlarm() {} } as never,
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
      onInit(ctx) {
        ctx.sql.exec('CREATE TABLE sessions (token TEXT, userId TEXT, role TEXT)');
        ctx.sql.exec("INSERT INTO sessions VALUES ('abc', 'user-1', 'admin')");
      },
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
});

describe("a plugin's upgrade(request, ctx)", () => {
  function buildWithStorage(definition: ServerDefinition) {
    const storage = createTestStorage();
    let captured: Engine | undefined;
    adapter({
      id: 'plugin-upgrade-ctx',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        captured = createEngine({
          storage,
          platform: { name: 'test-platform' },
          timers: { setAlarm() {}, deleteAlarm() {} } as never,
          logger: { info() {}, warn() {}, error() {} },
        });
        return {};
      },
    })(definition, undefined as never);
    if (!captured) throw new Error('engine not captured');

    return { engine: captured, storage };
  }

  function authPlugin(seen: Record<string, unknown>) {
    const scoped = server({
      scope: 'plugin',
      upgrade: async (_request, ctx) => {
        seen.ctx = ctx;
        seen.sameAsAccessor = context.upgrade(scoped) === ctx;
        try {
          context.upgrade(app);
        } catch (error) {
          seen.appBaseInPlugin = (error as Error).message;
        }

        await ctx.kv.set('last-seen', 'yes');

        return { meta: { fromPlugin: true } };
      },
    });
    const go = scoped.on('go', { run() {} });

    return plugin('acme:auth', { definition: scoped.assemble({ handlers: [go] }) });
  }

  const app = server({});

  it('receives its own ctx, which context.upgrade(pluginBase) returns', async () => {
    const seen: Record<string, unknown> = {};
    const Auth = authPlugin(seen);
    const base = server({ capabilities: [Auth()] });
    const { engine } = buildWithStorage(base.assemble({ handlers: [] }));
    await engine.initialize();

    await engine.handleUpgrade(new Request('https://x/'));

    const ctx = seen.ctx as InitContext;
    expect(typeof ctx.sql.exec).toBe('function');
    expect(typeof ctx.log.info).toBe('function');
    expect(ctx.platform).toEqual({ name: 'test-platform' });
    expect(seen.sameAsAccessor).toBe(true);
  });

  it('namespaces the kv keys that the plugin writes, like its handlers', async () => {
    const Auth = authPlugin({});
    const base = server({ capabilities: [Auth()] });
    const { engine, storage } = buildWithStorage(base.assemble({ handlers: [] }));
    await engine.initialize();

    await engine.handleUpgrade(new Request('https://x/'));

    expect(await storage.kv.get('__acme:auth::last-seen')).toBe('yes');
    expect(await storage.kv.get('last-seen')).toBeUndefined();
  });

  it("does not accept the app's base inside a plugin upgrade", async () => {
    const seen: Record<string, unknown> = {};
    const Auth = authPlugin(seen);
    const base = server({ capabilities: [Auth()] });
    const { engine } = buildWithStorage(base.assemble({ handlers: [] }));
    await engine.initialize();

    await engine.handleUpgrade(new Request('https://x/'));

    expect(seen.appBaseInPlugin).toMatch(/not the one running now/);
    expect(seen.appBaseInPlugin).toMatch(/a plugin's own base in that plugin's code/);
  });

  it("does not accept a plugin's base inside the app's upgrade", async () => {
    const seen: Record<string, unknown> = {};
    const Auth = authPlugin({});
    const pluginBase = server({ scope: 'plugin' });
    const base = server({
      capabilities: [Auth()],
      upgrade: () => {
        try {
          context.upgrade(pluginBase);
        } catch (error) {
          seen.pluginBaseInApp = (error as Error).message;
        }

        return { userId: 'u1' };
      },
    });
    const { engine } = buildWithStorage(base.assemble({ handlers: [] }));

    await engine.initialize();

    const decision = await engine.handleUpgrade(new Request('https://x/'));

    expect(seen.pluginBaseInApp).toMatch(/not the one running now/);
    expect(decision.reject).toBeFalsy();
  });
});

describe('plugin upgrades and the single userId', () => {
  function pluginReturning(
    id: string,
    result: { userId?: string; meta?: Record<string, unknown> },
  ) {
    const scoped = server({ scope: 'plugin', upgrade: () => result });
    const go = scoped.on('go', { run() {} });

    return plugin(id, { definition: scoped.assemble({ handlers: [go] }) });
  }

  async function upgradeWith(
    definition: ServerDefinition,
    logged: { message: string; data: Record<string, unknown> }[] = [],
  ) {
    let captured: Engine | undefined;
    adapter({
      id: 'plugin-user-id',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        captured = createEngine({
          storage: createTestStorage(),
          platform: {},
          timers: { setAlarm() {}, deleteAlarm() {} } as never,
          logger: {
            info() {},
            warn() {},
            error: (message: string, data?: Record<string, unknown>) =>
              logged.push({ message, data: data ?? {} }),
          },
        });
        return {};
      },
    })(definition, undefined as never);
    await captured!.initialize();

    return captured!.handleUpgrade(new Request('https://x/'));
  }

  it('names the plugin in the log, and not in the response, when its upgrade throws', async () => {
    const logged: { message: string; data: Record<string, unknown> }[] = [];
    const Ok = pluginReturning('acme:first', { meta: { first: 1 } });
    const failing = server({
      scope: 'plugin',
      upgrade: () => {
        throw new Error('region lookup failed');
      },
    });
    const Failing = plugin('acme:region', {
      definition: failing.assemble({ handlers: [failing.on('go', { run() {} })] }),
    });
    const base = server({ capabilities: [Ok(), Failing()] });

    const decision = await upgradeWith(base.assemble({ handlers: [] }), logged);

    expect(decision).toEqual({ reject: true, code: 500, reason: 'Upgrade failed' });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.data).toMatchObject({
      hook: "plugin 'acme:region'",
      error: 'region lookup failed',
    });
  });

  it('names the app in the log when the app upgrade throws', async () => {
    const logged: { message: string; data: Record<string, unknown> }[] = [];
    const Plugin = pluginReturning('acme:region', { meta: { region: 'eu' } });
    const base = server({
      capabilities: [Plugin()],
      upgrade: () => {
        throw new Error('session store down');
      },
    });

    await upgradeWith(base.assemble({ handlers: [] }), logged);

    expect(logged[0]?.data).toMatchObject({ hook: 'the app', error: 'session store down' });
  });

  it('merges the meta of a plugin that returns no userId with an app upgrade that returns one', async () => {
    const Plugin = pluginReturning('acme:region', { meta: { region: 'eu' } });
    const base = server({
      capabilities: [Plugin()],
      upgrade: () => ({ userId: 'u1', meta: { role: 'admin' } }),
    });

    const decision = await upgradeWith(base.assemble({ handlers: [] }));

    expect(decision.reject).toBeFalsy();
    expect(decision.userId).toBe('u1');
    expect(decision.meta).toEqual({ region: 'eu', role: 'admin' });
  });

  it('merges the meta of two plugins that return no userId', async () => {
    const First = pluginReturning('acme:first', { meta: { first: 1 } });
    const Second = pluginReturning('acme:second', { meta: { second: 2 } });
    const base = server({ capabilities: [First(), Second()] });

    const decision = await upgradeWith(base.assemble({ handlers: [] }));

    expect(decision.reject).toBeFalsy();
    expect(decision.meta).toEqual({ first: 1, second: 2 });
  });

  it('lets a plugin own the userId when the app upgrade returns none', async () => {
    const Plugin = pluginReturning('acme:auth', { userId: 'from-plugin' });
    const base = server({ capabilities: [Plugin()] });

    const decision = await upgradeWith(base.assemble({ handlers: [] }));

    expect(decision.reject).toBeFalsy();
    expect(decision.userId).toBe('from-plugin');
  });

  it('lets a plugin own the userId when the app upgrade returns only meta', async () => {
    const Plugin = pluginReturning('acme:auth', { userId: 'from-plugin' });
    const base = server({ capabilities: [Plugin()], upgrade: () => ({ meta: { role: 'admin' } }) });

    const decision = await upgradeWith(base.assemble({ handlers: [] }));

    expect(decision.reject).toBeFalsy();
    expect(decision.userId).toBe('from-plugin');
    expect(decision.meta).toEqual({ role: 'admin' });
  });

  it('leaves the userId out when no upgrade returns one, so the connection stays anonymous', async () => {
    const base = server({ upgrade: () => ({ meta: { role: 'guest' } }) });

    const decision = await upgradeWith(base.assemble({ handlers: [] }));

    expect(decision.reject).toBeFalsy();
    expect(decision.userId).toBeUndefined();
  });

  it('still rejects the handshake when a plugin and the app both return a userId', async () => {
    const Plugin = pluginReturning('acme:auth', { userId: 'from-plugin' });
    const base = server({ capabilities: [Plugin()], upgrade: () => ({ userId: 'u1' }) });

    const decision = await upgradeWith(base.assemble({ handlers: [] }));

    expect(decision.reject).toBe(true);
  });
});
