import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { ensureDurableStreamSchema, insertStream, readStream } from './storage.ts';

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'stream-durable-registrar-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        env: {},
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

describe('durable-stream registrar — purgeUser', () => {
  it('registers a purgeUser hook', async () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [resumableStream()] });
    const handler = base.assemble({ handlers: [] });
    const engine = buildEngine(handler);

    await engine.initialize();

    expect(engine.core.hooks.purgeUser).toHaveLength(1);
  });

  it("running the hook deletes the purged user's stream rows, leaving another user's rows intact", async () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [resumableStream()] });
    const handler = base.assemble({ handlers: [] });
    const engine = buildEngine(handler);

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
    const base = define({ env: t<Record<string, never>>(), capabilities: [resumableStream()] });
    const handler = base.assemble({ handlers: [] });
    const engine = buildEngine(handler);

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
    const base = define({ env: t<Record<string, never>>(), capabilities: [resumableStream()] });
    const handler = base.assemble({ handlers: [] });
    const engine = buildEngine(handler);

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
