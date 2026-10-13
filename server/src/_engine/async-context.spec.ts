import { AsyncLocalStorage } from 'node:async_hooks';
import { createAsyncContext, withCallContext } from '~/_engine/async-context.ts';
import { getCurrentCall, resetCallContextForTests } from '~/_engine/call-context.ts';
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => resetCallContextForTests());

describe('createAsyncContext', () => {
  it('works with a context object that the adapter froze, and still reports the base id', () => {
    const baseId = Symbol('base');
    // Freeze a wrapper, not Node's own storage: before Node 24, `run()` writes to the storage
    // object itself, so freezing that breaks Node, not LiveThing.
    const asyncContext = createAsyncContext(<TStore>() => {
      const storage = new AsyncLocalStorage<TStore>();
      return Object.freeze({
        run: <R>(store: TStore, fn: () => R) => storage.run(store, fn),
        getStore: () => storage.getStore(),
      });
    }, baseId);
    let seen: symbol | undefined;

    withCallContext(asyncContext, { kind: 'init', getCtx: () => ({}) }, () => {
      seen = getCurrentCall()?.baseId;
    });

    expect(Object.isFrozen(asyncContext)).toBe(true);
    expect(seen).toBe(baseId);
  });

  it('lets a call name its own base id, as a plugin hook does', () => {
    const appBase = Symbol('app');
    const pluginBase = Symbol('plugin');
    const asyncContext = createAsyncContext(<TStore>() => new AsyncLocalStorage<TStore>(), appBase);
    const seen: (symbol | undefined)[] = [];

    withCallContext(asyncContext, { kind: 'upgrade', getCtx: () => ({}), baseId: pluginBase }, () =>
      seen.push(getCurrentCall()?.baseId),
    );
    withCallContext(asyncContext, { kind: 'upgrade', getCtx: () => ({}) }, () =>
      seen.push(getCurrentCall()?.baseId),
    );

    expect(seen).toEqual([pluginBase, appBase]);
  });
});
