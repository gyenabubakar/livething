/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { emits } from '~/emits/emits.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { plugin } from './plugins.ts';

function buildEngine(handler: ServerDefinition, env: Record<string, unknown> = {}): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'plugin-init-e2e',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        env,
        platform: {},
        timers: createTestTimers(),
        waitUntil: () => {},
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  server(handler, undefined as never);
  if (!captured) throw new Error('engine not captured');
  return captured;
}

describe('plugin init — onion order end-to-end', () => {
  it('runs the plugin init before the app init through a real engine boot', async () => {
    const trace: string[] = [];

    const ph = define({ scope: 'plugin', capabilities: [emits({ ready: t<{}>() })] });
    ph.onInit(() => {
      trace.push('plugin');
    });
    const beat = ph.on('beat', { input: v.object({}), run() {} });
    const Plug = plugin('acme:boot', { handler: ph.assemble({ handlers: [beat] }) });

    const base = define({ env: t<{}>(), capabilities: [Plug()] });
    base.onInit(() => {
      trace.push('app');
    });
    const handler = base.assemble({
      handlers: [base.on('noop', { input: v.object({}), run() {} })],
    });

    const engine = buildEngine(handler);
    await engine.initialize();

    expect(trace).toEqual(['plugin', 'app']);
  });

  it('boots when the host and a plugin both declare tag groups of the same kind', async () => {
    const ph = define({
      scope: 'plugin',
      capabilities: [tags((ephemeral) => [ephemeral('plugin-role', t<string>())])],
    });
    const Plug = plugin('acme:tags', { handler: ph.assemble({ handlers: [] }) });

    const base = define({
      env: t<{}>(),
      capabilities: [tags((ephemeral) => [ephemeral('host-role', t<string>())]), Plug()],
    });

    const engine = buildEngine(base.assemble({ handlers: [] }));
    await expect(engine.initialize()).resolves.toBeUndefined();
  });

  it('passes the host environment to a plugin unchanged', async () => {
    const env = { services: { issuer: 'test-issuer' } };
    let seen: unknown;

    const ph = define({
      scope: 'plugin',
      env: t<typeof env>(),
    });
    ph.onInit((ctx) => {
      seen = ctx.env;
    });
    const Plug = plugin('acme:env', { handler: ph.assemble({ handlers: [] }) });

    const base = define({
      env: t<typeof env>(),
      capabilities: [Plug()],
    });
    const engine = buildEngine(base.assemble({ handlers: [] }), env);

    await engine.initialize();

    expect(seen).toBe(env);
  });
});
