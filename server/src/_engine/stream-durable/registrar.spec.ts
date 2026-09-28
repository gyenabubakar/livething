import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { sweepDurableStreams } from './runtime.ts';
import { ensureDurableStreamSchema, insertStream, readStream } from './storage.ts';

function buildEngine(
  definition: ServerDefinition,
  storage: ReturnType<typeof createTestStorage> = createTestStorage(),
): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'stream-durable-registrar-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage,

        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

describe('durable-stream registrar — purgeUser', () => {
  it('registers a purgeUser hook', async () => {
    const base = server({ capabilities: [resumableStream()] });
    const definition = base.assemble({ handlers: [] });
    const engine = buildEngine(definition);

    await engine.initialize();

    expect(engine.core.hooks.purgeUser).toHaveLength(1);
  });

  it("running the hook deletes the purged user's stream rows, leaving another user's rows intact", async () => {
    const base = server({ capabilities: [resumableStream()] });
    const definition = base.assemble({ handlers: [] });
    const engine = buildEngine(definition);

    await engine.initialize();

    const sql = engine.core.storage.sql;
    ensureDurableStreamSchema(sql);
    insertStream(sql, {
      userId: 'u-1',
      streamId: 's-1',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: 1_000,
    });
    insertStream(sql, {
      userId: 'u-2',
      streamId: 's-2',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: 1_000,
    });

    await engine.core.hooks.purgeUser[0]!(engine.core, 'u-1');

    expect(readStream(sql, 'u-1', 's-1')).toBeNull();
    expect(readStream(sql, 'u-2', 's-2')).not.toBeNull();
  });

  it('forwards purgeUser options through to purgeStreamsByUser', async () => {
    const base = server({ capabilities: [resumableStream()] });
    const definition = base.assemble({ handlers: [] });
    const engine = buildEngine(definition);

    await engine.initialize();

    const sql = engine.core.storage.sql;
    ensureDurableStreamSchema(sql);
    insertStream(sql, {
      userId: '__bcast:ch:room__',
      streamId: 's-broadcast',
      event: 'e',
      payload: '{}',
      kind: 'resumable',
      now: 1_000,
      broadcast: true,
      creatorUserId: 'u-1',
    });

    // The registered hook accepts a third `options` argument at runtime; the
    // shared hook array type only declares two. See purge-user.ts for why.
    const hook = engine.core.hooks.purgeUser[0] as unknown as (
      core: unknown,
      userId: string,
      options: { keepBroadcastContent?: boolean },
    ) => void | Promise<void>;
    await hook(engine.core, 'u-1', { keepBroadcastContent: true });

    const row = readStream(sql, '__bcast:ch:room__', 's-broadcast');
    expect(row).not.toBeNull();
    expect(row?.creatorUserId).toBeNull();
  });
});

describe('durable-stream registrar — boot schema', () => {
  it('creates the durable-stream tables at boot, before any stream is ever started', async () => {
    const base = server({ capabilities: [resumableStream()] });
    const definition = base.assemble({ handlers: [] });
    const engine = buildEngine(definition);

    await engine.initialize();

    const sql = engine.core.storage.sql;
    // No ensureDurableStreamSchema(sql) call here — proves onBootSchema alone
    // created the table, matching how every other owning capability does it.
    expect(() =>
      insertStream(sql, {
        userId: 'u-1',
        streamId: 's-1',
        event: 'e',
        payload: '{}',
        kind: 'resumable',
        now: 1_000,
      }),
    ).not.toThrow();
    expect(readStream(sql, 'u-1', 's-1')).not.toBeNull();
  });
});

describe('durable-stream registrar — restart', () => {
  it('pauses a stream the previous process left running, so the sweep can expire it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const storage = createTestStorage();
      ensureDurableStreamSchema(storage.sql);
      insertStream(storage.sql, {
        userId: 'alice',
        streamId: 'ask-scout-1',
        event: 'answer',
        payload: '{}',
        kind: 'resumable',
        now: 1_000,
        maxAgeMs: 60_000,
      });

      vi.setSystemTime(5_000);
      const base = server({ capabilities: [resumableStream()] });
      const engine = buildEngine(base.assemble({ handlers: [] }), storage);
      await engine.initialize();

      expect(readStream(storage.sql, 'alice', 'ask-scout-1')?.status).toBe('suspended');

      vi.setSystemTime(5_000 + 60_001);
      expect(sweepDurableStreams({ sql: storage.sql })).toBe(1);
      expect(readStream(storage.sql, 'alice', 'ask-scout-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
