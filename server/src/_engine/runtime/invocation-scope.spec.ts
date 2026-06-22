import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { EngineAsyncContextStore } from '~/_engine/async-context.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import { deleteConnectionState, persistAttachment } from './hibernation.ts';
import { withInvocationScope } from './invocation-scope.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/** Minimal EngineCore stub — only the fields the helpers under test read. */
function createFakeCore(): {
  core: EngineCore;
  writes: string[];
  attachments: { wsKey: unknown; snapshot: unknown }[];
} {
  const writes: string[] = [];
  const attachments: { wsKey: unknown; snapshot: unknown }[] = [];

  const sql = {
    exec: vi.fn((query: string) => {
      writes.push(query.trim().split(/\s+/).slice(0, 2).join(' '));
      return { toArray: () => [], one: () => null, raw: () => [] };
    }),
    transaction: vi.fn(<T>(fn: (tx: unknown) => T) => fn(sql)),
  };

  const core = {
    hibernationEnabled: true,
    asyncContext: new AsyncLocalStorage<EngineAsyncContextStore>(),
    options: {
      hibernation: {
        persist(wsKey: unknown, snapshot: unknown) {
          attachments.push({ wsKey, snapshot });
        },
      },
    },
    requireStorage: () => ({ sql }),
  } as unknown as EngineCore;

  return { core, writes, attachments };
}

function createFakeConnection(id: string): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: { key: id },
    descriptor: {} as never,
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

describe('withInvocationScope', () => {
  it('batches multiple persistAttachment calls for one connection into a single flush', async () => {
    const { core, writes } = createFakeCore();
    const connection = createFakeConnection('c1');

    await withInvocationScope(core, async () => {
      // Five state changes inside one invocation — without batching this is
      // five writes; with batching it collapses to one at scope close.
      for (let step = 1; step <= 5; step += 1) {
        connection.meta = { step };
        persistAttachment(core, connection);
      }
      expect(writes).toEqual([]);
    });

    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(1);
  });

  it('flushes each touched connection once, even when many are dirty', async () => {
    const { core, writes } = createFakeCore();
    const a = createFakeConnection('a');
    const b = createFakeConnection('b');
    const c = createFakeConnection('c');

    await withInvocationScope(core, async () => {
      a.meta = { x: 1 };
      persistAttachment(core, a);
      b.meta = { x: 1 };
      persistAttachment(core, b);
      a.meta = { x: 2 };
      persistAttachment(core, a);
      c.meta = { x: 1 };
      persistAttachment(core, c);
    });

    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(3);
  });

  it('does no SQL work when the scope opens and closes with no state changes', async () => {
    const { core, writes } = createFakeCore();

    await withInvocationScope(core, async () => {});

    expect(writes).toEqual([]);
  });

  it('skips the queued flush when the persisted columns did not actually change', async () => {
    const { core, writes } = createFakeCore();
    const connection = createFakeConnection('c1');

    // Prime the fingerprint with one write outside the scope.
    persistAttachment(core, connection);
    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(1);

    await withInvocationScope(core, async () => {
      // Same state, twice — fingerprint matches, no SQL.
      persistAttachment(core, connection);
      persistAttachment(core, connection);
    });

    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(1);
  });

  it('nested scopes share the outermost; only the outer flush hits SQL', async () => {
    const { core, writes } = createFakeCore();
    const connection = createFakeConnection('c1');

    await withInvocationScope(core, async () => {
      connection.meta = { step: 1 };
      persistAttachment(core, connection);

      await withInvocationScope(core, async () => {
        connection.meta = { step: 2 };
        persistAttachment(core, connection);
      });

      expect(writes).toEqual([]);

      connection.meta = { step: 3 };
      persistAttachment(core, connection);
    });

    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(1);
  });

  it('still flushes when the handler throws — the finally block commits work-up-to-throw', async () => {
    const { core, writes } = createFakeCore();
    const connection = createFakeConnection('c1');

    await expect(
      withInvocationScope(core, async () => {
        connection.meta = { committed: true };
        persistAttachment(core, connection);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(1);
  });

  it('drops a queued flush when the connection is deleted before the scope closes', async () => {
    const { core, writes } = createFakeCore();
    const connection = createFakeConnection('c1');

    await withInvocationScope(core, async () => {
      connection.meta = { ephemeral: true };
      persistAttachment(core, connection);
      // Disconnect mid-invocation — the queued flush must not run, or it
      // would resurrect the deleted row.
      deleteConnectionState(core, connection.id);
    });

    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(0);
    expect(writes.filter((q) => q.startsWith('DELETE'))).toHaveLength(1);
  });

  it('does not recreate a deleted row when later cleanup tries to persist the closing connection', async () => {
    const { core, writes } = createFakeCore();
    const connection = createFakeConnection('c1');

    await withInvocationScope(core, async () => {
      connection.meta = { beforeClose: true };
      persistAttachment(core, connection);
      connection.closing = true;
      deleteConnectionState(core, connection.id);

      connection.meta = { afterClose: true };
      persistAttachment(core, connection);
    });

    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(0);
    expect(writes.filter((q) => q.startsWith('DELETE'))).toHaveLength(1);
  });

  it('outside any scope, persistAttachment writes immediately (back-compat)', () => {
    const { core, writes } = createFakeCore();
    const connection = createFakeConnection('c1');

    connection.meta = { hello: 'world' };
    persistAttachment(core, connection);

    expect(writes.filter((q) => q.startsWith('INSERT'))).toHaveLength(1);
  });

  it('no-ops when hibernation is disabled, with or without an active scope', async () => {
    const { core, writes } = createFakeCore();
    (core as unknown as { hibernationEnabled: boolean }).hibernationEnabled = false;
    const connection = createFakeConnection('c1');

    persistAttachment(core, connection);
    await withInvocationScope(core, async () => {
      persistAttachment(core, connection);
      persistAttachment(core, connection);
    });

    expect(writes).toEqual([]);
  });
});
