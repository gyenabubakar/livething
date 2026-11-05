/* oxlint-disable @typescript-eslint/no-explicit-any */
import { LiveThingError } from '@livething/core';
import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { normalizeRuntimeError } from '~/errors/runtime.ts';
import { error, t } from '~/index.ts';
import { sendThroughPipeline } from '~/outgoing/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { plugin } from './plugins.ts';

/** Minimal outgoing runtime with no hooks/stampers — just the compiled scope. */
function outgoingRuntime(compiled: any) {
  return {
    compiled,
    outgoingHooks: [],
    livethingStampHooks: [],
    logger: { warn() {}, error() {} },
    generateId: () => 'id_1',
  } as any;
}

/** Pull a plugin's namespaced primitive out of its capability `__primitives`. */
function findPrimitive(primitives: readonly any[], livething: string, event: string) {
  const found = primitives.find((p) => p.__livething === livething && p.event === event);
  if (!found) throw new Error(`no ${livething} primitive for ${event}`);

  return found;
}

describe('plugin engine defect — a plugin can emit its own declared event', () => {
  it('sends a scoped emits() event out on the wire as __<id>::<name>', () => {
    const h = server({
      scope: 'plugin',
      capabilities: [emits({ 'own-event': t<{ ok: boolean }>() })],
    });
    const beat = h.on('go', {
      input: v.object({}),
      run(ctx) {
        ctx.send('own-event', { ok: true });
      },
    });
    const base = server({
      capabilities: [plugin('e2e:drizzle', { definition: h.assemble({ handlers: [beat] }) })()],
    });
    const compiled = compileServerDefinition(base.assemble({ handlers: [] }));

    const sent: string[] = [];
    const connection = {
      id: 'conn_1',
      meta: {},
      descriptor: { send: ({ text }: { text: string }) => sent.push(text) },
    } as any;

    expect(() =>
      sendThroughPipeline(outgoingRuntime(compiled), connection, {
        routing: undefined,
        event: '__e2e:drizzle::own-event',
        payload: { ok: true },
      }),
    ).not.toThrow();

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)[0]).toBe('__e2e:drizzle::own-event');
  });

  it('still rejects a genuinely undeclared __x__ event', () => {
    const base = server({});
    const compiled = compileServerDefinition(base.assemble({ handlers: [] }));
    const connection = { id: 'c', meta: {}, descriptor: { send() {} } } as any;

    expect(() =>
      sendThroughPipeline(outgoingRuntime(compiled), connection, {
        routing: undefined,
        event: '__nope__',
        payload: {},
      }),
    ).toThrow(/not declared in the active scope/);
  });
});

describe('plugin engine defect — a plugin can throw its own declared typed error', () => {
  const Denied = error('denied', v.object({ reason: v.string() }));

  function buildAuthPlugin() {
    const h = server({
      scope: 'plugin',
      capabilities: [emits({ done: t<{}>() }), errors([Denied])],
    });
    const sync = h.on('deny-sync', {
      input: v.object({}),
      run() {
        throw Denied({ reason: 'sync-no' });
      },
    });
    const asyncDeny = h.on('deny-async', {
      input: v.object({}),
      async run() {
        await Promise.resolve();
        throw Denied({ reason: 'async-no' });
      },
    });
    const undeclared = h.on('boom', {
      input: v.object({}),
      run() {
        throw new LiveThingError('not-mine', { x: 1 });
      },
    });

    return plugin('acme:auth', {
      definition: h.assemble({ handlers: [sync, asyncDeny, undeclared] }),
    })();
  }

  const declaredCodes = new Set(['__acme:auth::denied']);

  it('rewrites a sync throw to the namespaced wire code with detail intact', () => {
    const { __primitives } = buildAuthPlugin();
    const incoming = findPrimitive(__primitives, 'incoming', '__acme:auth::deny-sync');

    let thrown: unknown;
    try {
      incoming.handler({ id: 'c1' }, {});
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(LiveThingError);
    expect((thrown as LiveThingError).code).toBe('__acme:auth::denied');
    expect((thrown as LiveThingError).detail).toEqual({ reason: 'sync-no' });
    expect(normalizeRuntimeError(thrown, undefined, declaredCodes)).toEqual({
      payload: { code: '__acme:auth::denied', detail: { reason: 'sync-no' } },
      livething: {},
    });
  });

  it('rewrites an async (awaited) throw to the namespaced wire code', async () => {
    const { __primitives } = buildAuthPlugin();
    const incoming = findPrimitive(__primitives, 'incoming', '__acme:auth::deny-async');

    const thrown = await incoming.handler({ id: 'c1' }, {}).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(LiveThingError);
    expect((thrown as LiveThingError).code).toBe('__acme:auth::denied');
    expect((thrown as LiveThingError).detail).toEqual({ reason: 'async-no' });
    expect(normalizeRuntimeError(thrown, undefined, declaredCodes)).toEqual({
      payload: { code: '__acme:auth::denied', detail: { reason: 'async-no' } },
      livething: {},
    });
  });

  it('leaves an undeclared throw alone so it still collapses to internal-error', () => {
    const { __primitives } = buildAuthPlugin();
    const incoming = findPrimitive(__primitives, 'incoming', '__acme:auth::boom');

    let thrown: unknown;
    try {
      incoming.handler({ id: 'c1' }, {});
    } catch (e) {
      thrown = e;
    }

    expect((thrown as LiveThingError).code).toBe('not-mine');
    expect(normalizeRuntimeError(thrown, undefined, declaredCodes)).toEqual({
      payload: { code: 'internal-error' },
      livething: {},
    });
  });

  it('does not wrap handlers when the plugin declares no errors', () => {
    const h = server({ scope: 'plugin', capabilities: [emits({ done: t<{}>() })] });
    const original = vi.fn();
    const go = h.on('go', { input: v.object({}), run: original });
    const { __primitives } = plugin('acme:plain', { definition: h.assemble({ handlers: [go] }) })();
    const incoming = findPrimitive(__primitives, 'incoming', '__acme:plain::go');

    incoming.handler({ id: 'c1' }, {});
    expect(original).toHaveBeenCalledTimes(1);
  });
});
