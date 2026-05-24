import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { PluginRuntime, RuntimeConnection } from '~/_engine/runtime/types.ts';
import { createPluginHooks } from './plugin-hooks.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createHooks(core: {
  asyncContext?: AsyncLocalStorage<string>;
  connections: Map<string, RuntimeConnection>;
  engineInstanceId: string | undefined;
}) {
  const runtime = { instance: { id: 'm1' } } as unknown as PluginRuntime;
  return createPluginHooks(core as unknown as EngineCore, runtime, () => {});
}

describe('plugin hooks — getState()', () => {
  it('throws when the adapter provides no async-context capability', () => {
    const hooks = createHooks({ connections: new Map(), engineInstanceId: undefined });
    expect(() => hooks.getState()).toThrow('async-context support');
  });

  it('resolves the connection from the active async context', () => {
    const asyncContext = new AsyncLocalStorage<string>();
    const hooks = createHooks({
      asyncContext,
      connections: new Map([['c1', createConnection('c1')]]),
      engineInstanceId: undefined,
    });

    expect(asyncContext.run('c1', () => hooks.getState().id)).toBe('c1');
    // Outside any run() there is no active connection — empty placeholder.
    expect(hooks.getState().id).toBe('');
  });

  it('keeps interleaved connections isolated — each getState() sees its own', async () => {
    const asyncContext = new AsyncLocalStorage<string>();
    const hooks = createHooks({
      asyncContext,
      connections: new Map([
        ['A', createConnection('A')],
        ['B', createConnection('B')],
      ]),
      engineInstanceId: undefined,
    });

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const seen: Record<string, string> = {};

    // A's flow suspends at the await; B's flow runs fully in that gap.
    const runA = asyncContext.run('A', async () => {
      await gateA;
      seen.A = hooks.getState().id;
    });
    const runB = asyncContext.run('B', async () => {
      seen.B = hooks.getState().id;
    });

    await runB;
    releaseA();
    await runA;

    // A global "active connection" would have let B overwrite A's; the async
    // context keeps each flow's connection isolated.
    expect(seen).toEqual({ A: 'A', B: 'B' });
  });
});
