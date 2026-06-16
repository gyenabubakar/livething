/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { emits } from '~/emits/emits.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { plugin } from './plugin.ts';

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'plugin-init-e2e',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: undefined,
        env: {},
        platform: {},
        timers: undefined as never,
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

    const ph = define({ scoped: true, capabilities: [emits({ ready: t<{}>() })] });
    ph.init(() => {
      trace.push('plugin');
    });
    const beat = ph.on('beat', { input: v.object({}), run() {} });
    const Plug = plugin('acme:boot', { handler: ph.assemble(beat) });

    const base = define({ env: t<{}>(), capabilities: [Plug()] });
    base.init(() => {
      trace.push('app');
    });
    const handler = base.assemble(base.on('noop', { input: v.object({}), run() {} }));

    const engine = buildEngine(handler);
    await engine.initialize();

    expect(trace).toEqual(['plugin', 'app']);
  });
});
