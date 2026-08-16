/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  handleShutdown,
  handleUpgrade,
  runConnectionLifecycle,
} from '~/_engine/runtime/connection.ts';
import { describe, expect, it } from 'vitest';

const noopAsyncContext = new AsyncLocalStorage<{ connectionId?: string }>();

function push(trace: string[], label: string): () => void {
  return () => {
    trace.push(label);
  };
}

function lifecycleRuntime(
  trace: string[],
  overrides: Partial<Parameters<typeof runConnectionLifecycle>[0]> = {},
): Parameters<typeof runConnectionLifecycle>[0] {
  return {
    connectHooks: [push(trace, 'app')],
    disconnectHooks: [push(trace, 'app')],
    asyncContext: noopAsyncContext,
    createPluginScopedContext: (_id: string, ctx: any) => ctx,
    ...overrides,
  } as Parameters<typeof runConnectionLifecycle>[0];
}

describe('plugin onion ordering — connect/disconnect', () => {
  it('runs plugin connect hooks before the app, in registration order', async () => {
    const trace: string[] = [];
    await runConnectionLifecycle(
      lifecycleRuntime(trace, {
        connectHooks: [push(trace, 'app')],
        pluginConnectHooks: [{ handler: push(trace, 'p1') }, { handler: push(trace, 'p2') }],
      }),
      'connect',
      { id: 'c1' },
    );
    expect(trace).toEqual(['p1', 'p2', 'app']);
  });

  it('runs the app disconnect before plugins, plugins LIFO', async () => {
    const trace: string[] = [];
    await runConnectionLifecycle(
      lifecycleRuntime(trace, {
        disconnectHooks: [push(trace, 'app')],
        pluginDisconnectHooks: [{ handler: push(trace, 'p1') }, { handler: push(trace, 'p2') }],
      }),
      'disconnect',
      { id: 'c1' },
    );
    expect(trace).toEqual(['app', 'p2', 'p1']);
  });
});

describe('plugin onion ordering — shutdown', () => {
  it('runs the app shutdown before plugins, plugins LIFO', async () => {
    const trace: string[] = [];
    await handleShutdown({
      connections: new Map(),
      shutdownHooks: [push(trace, 'app')],
      pluginShutdownHooks: [{ handler: push(trace, 'p1') }, { handler: push(trace, 'p2') }],
      createShutdownContext: () => ({}),
      cancelActiveStreamsForConnection: async () => {},
      handleConnectionClose: async () => {},
    } as any);
    expect(trace).toEqual(['app', 'p2', 'p1']);
  });
});

describe('plugin upgrade — meta merge + user id single owner', () => {
  const helpers = {};

  function baseRuntime(overrides: Record<string, unknown>) {
    return {
      upgradeHooks: [],
      pluginUpgradeHooks: [],
      builderUpgradeHook: undefined,
      upgradeHelpers: helpers,
      isTagGroupDeclared: () => true,
      ...overrides,
    } as any;
  }

  it('runs plugin upgrades first, app wins on meta key conflict', async () => {
    const order: string[] = [];
    const decision = await handleUpgrade(
      baseRuntime({
        pluginUpgradeHooks: [
          {
            pluginId: 'acme:a',
            handler: () => {
              order.push('a');
              return { meta: { shared: 'plugin', fromPlugin: 1 } };
            },
          },
        ],
        builderUpgradeHook: () => {
          order.push('app');
          return { userId: 'u1', meta: { shared: 'app' } };
        },
      }),
      new Request('https://x/'),
    );
    expect(order).toEqual(['a', 'app']);
    expect(decision.userId).toBe('u1');
    expect(decision.meta).toEqual({ shared: 'app', fromPlugin: 1 });
  });

  it('lets a plugin own the user id when the app does not', async () => {
    const decision = await handleUpgrade(
      baseRuntime({
        pluginUpgradeHooks: [
          {
            pluginId: 'clerk:auth',
            handler: () => ({ userId: 'sub_1', meta: { userId: 'sub_1' } }),
          },
        ],
      }),
      new Request('https://x/'),
    );
    expect(decision.userId).toBe('sub_1');
    expect(decision.meta).toEqual({ userId: 'sub_1' });
  });

  it('rejects when two upgrade hooks both return a user id', async () => {
    const decision = await handleUpgrade(
      baseRuntime({
        pluginUpgradeHooks: [{ pluginId: 'clerk:auth', handler: () => ({ userId: 'sub_1' }) }],
        builderUpgradeHook: () => ({ userId: 'sub_2' }),
      }),
      new Request('https://x/'),
    );
    // A thrown error inside upgrade surfaces as a 500 reject, not a crash.
    expect(decision.reject).toBe(true);
    expect(decision.code).toBe(500);
  });

  it('concatenates tags across plugin and app upgrades', async () => {
    const decision = await handleUpgrade(
      baseRuntime({
        pluginUpgradeHooks: [
          {
            pluginId: 'acme:a',
            handler: () => ({
              tags: [{ __wskit: 'tag-ref', kind: 'ephemeral', group: 'g', key: 'k1' }],
            }),
          },
        ],
        builderUpgradeHook: () => ({
          userId: 'u',
          tags: [{ __wskit: 'tag-ref', kind: 'ephemeral', group: 'g', key: 'k2' }],
        }),
      }),
      new Request('https://x/'),
    );
    expect(decision.tags).toHaveLength(2);
  });
});
