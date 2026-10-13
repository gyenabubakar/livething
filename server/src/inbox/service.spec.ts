import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { inbox } from './capability.ts';
import { advanceReceivedThrough, listReceivers } from './receipts-storage.ts';
import {
  bumpInboxWatermark,
  insertInboxRows,
  loadInboxWatermarks,
  loadUndeliveredRows,
} from './storage.ts';

function buildEngine(definition: ServerDefinition, storage = createTestStorage()): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'inbox-service-spec',
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

function buildInboxEngine(storage = createTestStorage()): Engine {
  const base = server({
    capabilities: [channels(), sequence({ persist: true }), dedup()],
  });
  const chat = base.channel('chat', { capabilities: [inbox()] });
  const definition = base.assemble({ handlers: [chat] });
  return buildEngine(definition, storage);
}

function buildChannelsOnlyEngine(): Engine {
  const base = server({
    capabilities: [channels(), sequence({ persist: true }), dedup()],
  });
  const chat = base.channel('chat', {});
  const definition = base.assemble({ handlers: [chat] });
  return buildEngine(definition);
}

describe('inbox runtime install', () => {
  it('registers a purgeUser hook, on top of the one channels() already registers', async () => {
    const withoutInbox = buildChannelsOnlyEngine();
    await withoutInbox.initialize();
    const baseline = withoutInbox.core.hooks.purgeUser.length;

    const withInbox = buildInboxEngine();
    await withInbox.initialize();

    expect(withInbox.core.hooks.purgeUser).toHaveLength(baseline + 1);
  });

  it("purging a user deletes their inbox rows, leaving another user's rows intact", async () => {
    const engine = buildInboxEngine();
    await engine.initialize();

    const core = engine.core;
    insertInboxRows(core.storage.sql, {
      userIds: ['alice', 'bob'],
      channelName: 'chat',
      channelFamily: null,
      frame: { event: 'room-msg', payload: { text: 'hi' }, deliverySeq: 1, messageId: 'm1' },
      now: 1000,
    });

    await purgeUser(core, 'alice');

    expect(loadUndeliveredRows(core.storage.sql, 'alice')).toEqual([]);
    expect(loadUndeliveredRows(core.storage.sql, 'bob')).toHaveLength(1);
  });

  it('runs all three inbox purge deletes inside one SQL transaction', async () => {
    let activeTransaction: number | null = null;
    let transactionCalls = 0;
    const deleteTransactions: number[] = [];
    const storage = createTestStorage({
      onExec(query) {
        if (/DELETE FROM __livething_inbox(?:_watermark|_receipts)? WHERE user_id/.test(query)) {
          deleteTransactions.push(activeTransaction ?? -1);
        }
      },
    });
    const runTransaction = storage.sql.transaction.bind(storage.sql);

    storage.sql.transaction = <T>(fn: () => T): T => {
      const transactionId = ++transactionCalls;
      return runTransaction(() => {
        const previous = activeTransaction;
        activeTransaction = transactionId;
        try {
          return fn();
        } finally {
          activeTransaction = previous;
        }
      });
    };
    const engine = buildInboxEngine(storage);
    await engine.initialize();
    transactionCalls = 0;

    await purgeUser(engine.core, 'alice');

    expect(transactionCalls).toBe(1);
    expect(deleteTransactions).toEqual([1, 1, 1]);
  });

  it.each([
    ['inbox rows', '__livething_inbox WHERE user_id'],
    ['watermarks', '__livething_inbox_watermark WHERE user_id'],
    ['receipts', '__livething_inbox_receipts WHERE user_id'],
  ])('attempts all durable deletes when %s fails', async (_name, needle) => {
    let injected = false;
    const storage = createTestStorage({
      onExec(query) {
        if (!injected && query.includes(`DELETE FROM ${needle}`)) {
          injected = true;
          throw new Error(`injected ${_name} failure`);
        }
      },
    });
    const engine = buildEngine(
      (() => {
        const base = server({
          capabilities: [channels(), sequence({ persist: true }), dedup()],
        });
        return base.assemble({ handlers: [base.channel('chat', { capabilities: [inbox()] })] });
      })(),
      storage,
    );
    await engine.initialize();
    const core = engine.core;

    const setAlarm = vi.fn(async () => {});
    const deleteAlarm = vi.fn(async () => {});
    core.timers.setAlarm = setAlarm;
    core.timers.deleteAlarm = deleteAlarm;
    insertInboxRows(core.storage.sql, {
      userIds: ['alice'],
      channelName: 'chat',
      channelFamily: null,
      frame: { event: 'room-msg', payload: {}, deliverySeq: 1, messageId: 'm1' },
      now: 1,
    });

    bumpInboxWatermark(core.storage.sql, {
      userId: 'alice',
      channelName: 'chat',
      channelFamily: null,
      evictedThroughSeq: 1,
    });
    advanceReceivedThrough(core.storage.sql, {
      channelName: 'chat',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 1,
      now: 1,
    });

    await expect(purgeUser(core, 'alice')).rejects.toThrow(AggregateError);
    expect(core.inboxReceiptCursors.size).toBe(0);
    expect(core.inboxMemberCounts.size).toBe(0);
    expect(setAlarm.mock.calls.length + deleteAlarm.mock.calls.length).toBeGreaterThan(0);
    expect(loadUndeliveredRows(core.storage.sql, 'alice')).toHaveLength(
      _name === 'inbox rows' ? 1 : 0,
    );

    expect(loadInboxWatermarks(core.storage.sql, 'alice')).toHaveLength(
      _name === 'watermarks' ? 1 : 0,
    );
    expect(
      listReceivers(core.storage.sql, { channelName: 'chat', channelFamily: null, seq: 1 }),
    ).toHaveLength(_name === 'receipts' ? 1 : 0);
  });

  it('preserves multiple inbox delete failures while still clearing caches and rescheduling', async () => {
    const storage = createTestStorage({
      onExec(query) {
        if (
          query.includes('DELETE FROM __livething_inbox WHERE user_id') ||
          query.includes('DELETE FROM __livething_inbox_receipts WHERE user_id')
        ) {
          throw new Error(
            query.includes('__livething_inbox_receipts') ? 'receipts failed' : 'inbox failed',
          );
        }
      },
    });
    const base = server({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const engine = buildEngine(
      base.assemble({ handlers: [base.channel('chat', { capabilities: [inbox()] })] }),
      storage,
    );
    await engine.initialize();
    const core = engine.core;

    core.inboxReceiptCursors.set(JSON.stringify(['chat', null, 'alice']), {
      receivedThrough: 1,
      readThrough: 1,
    });
    core.inboxMemberCounts.set(JSON.stringify(['chat', null, 'alice']), 1);
    const setAlarm = vi.fn(async () => {});
    const deleteAlarm = vi.fn(async () => {});
    core.timers.setAlarm = setAlarm;

    core.timers.deleteAlarm = deleteAlarm;

    let caught: unknown;
    try {
      await purgeUser(core, 'alice');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const errors = (caught as AggregateError).errors;
    expect(errors).toHaveLength(1);

    const inboxErrors = (errors[0] as AggregateError).errors;
    expect(inboxErrors).toHaveLength(2);
    expect(inboxErrors.map((error) => (error as Error).message)).toEqual(
      expect.arrayContaining(['inbox failed', 'receipts failed']),
    );
    expect(core.inboxReceiptCursors.size).toBe(0);
    expect(core.inboxMemberCounts.size).toBe(0);

    expect(setAlarm.mock.calls.length + deleteAlarm.mock.calls.length).toBeGreaterThan(0);
  });

  it.each([
    ['setAlarm', 100],
    ['deleteAlarm', null],
  ] as const)(
    'aggregates a rejected %s write after durable deletes and cache clearing finish',
    async (method, deadline) => {
      const engine = buildInboxEngine();
      await engine.initialize();
      const core = engine.core;
      core.inboxReceiptCursors.set(JSON.stringify(['chat', null, 'alice']), {
        receivedThrough: 1,
        readThrough: 1,
      });
      core.inboxMemberCounts.set(JSON.stringify(['chat', null, 'alice']), 1);

      insertInboxRows(core.storage.sql, {
        userIds: ['alice'],
        channelName: 'chat',
        channelFamily: null,
        frame: { event: 'room-msg', payload: {}, deliverySeq: 1, messageId: 'm1' },
        now: 1,
      });

      if (deadline !== null) core.alarmSources.set(Symbol('purge-test'), () => deadline);
      core.timers.setAlarm = vi.fn(async () => {
        if (method === 'setAlarm') throw new Error('set alarm failed');
      });
      core.timers.deleteAlarm = vi.fn(async () => {
        if (method === 'deleteAlarm') throw new Error('delete alarm failed');
      });

      let caught: unknown;
      try {
        await purgeUser(core, 'alice');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const inboxFailure = (caught as AggregateError).errors[0];
      expect(inboxFailure).toBeInstanceOf(AggregateError);
      expect((inboxFailure as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: `${method === 'setAlarm' ? 'set' : 'delete'} alarm failed`,
        }),
      ]);
      expect(loadUndeliveredRows(core.storage.sql, 'alice')).toEqual([]);

      expect(core.inboxReceiptCursors.size).toBe(0);
      expect(core.inboxMemberCounts.size).toBe(0);
    },
  );

  it('purging a user clears their cached receipt cursor, so a reconnect on the same instance starts from zero instead of inheriting it', async () => {
    const engine = buildInboxEngine();
    await engine.initialize();
    const core = engine.core;

    advanceReceivedThrough(
      core.storage.sql,
      { channelName: 'chat', channelFamily: null, userId: 'alice', receivedThrough: 10, now: 1 },
      core.inboxReceiptCursors,
    );
    expect(core.inboxReceiptCursors.size).toBe(1);

    await purgeUser(core, 'alice');

    expect(core.inboxReceiptCursors.size).toBe(0);
    // Re-advancing after the purge must start from the stored (purged) value,
    // not the stale cached one — this is what a reconnect on the same
    // instance would observe.
    const result = advanceReceivedThrough(
      core.storage.sql,
      { channelName: 'chat', channelFamily: null, userId: 'alice', receivedThrough: 3, now: 2 },
      core.inboxReceiptCursors,
    );
    expect(result).toEqual({ receivedThrough: 3, readThrough: 0, changed: true });
    expect(
      listReceivers(core.storage.sql, { channelName: 'chat', channelFamily: null, seq: 3 }),
    ).toEqual(['alice']);
  });

  it("purging a user clears their cached inbox member count, leaving another user's count intact", async () => {
    const engine = buildInboxEngine();
    await engine.initialize();
    const core = engine.core;

    core.inboxMemberCounts.set(JSON.stringify(['chat', null, 'alice']), 4);
    core.inboxMemberCounts.set(JSON.stringify(['chat', null, 'bob']), 2);

    await purgeUser(core, 'alice');

    expect(core.inboxMemberCounts.has(JSON.stringify(['chat', null, 'alice']))).toBe(false);
    expect(core.inboxMemberCounts.get(JSON.stringify(['chat', null, 'bob']))).toBe(2);
  });
});
