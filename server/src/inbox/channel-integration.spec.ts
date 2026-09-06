import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { define } from '~/_define/define.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { channels } from '~/channel/capability.ts';
import { persistMembership } from '~/channel/membership.ts';
import { dedup } from '~/dedup/capability.ts';
import {
  bumpInboxWatermark,
  insertInboxRows,
  loadInboxWatermarks,
  loadUndeliveredRows,
} from '~/inbox/storage.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { inbox } from './capability.ts';
import {
  advanceReadThrough,
  advanceReceivedThrough,
  listReaders,
  listReceivers,
} from './receipts-storage.ts';

function buildEngine(
  handler: ServerDefinition,
  storage = createTestStorage(),
): { engine: Engine; getAlarm: () => number | null } {
  let captured: Engine | undefined;
  let alarm: number | null = null;
  const server = adapter({
    id: 'inbox-channel-integration-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage,

        platform: {},
        timers: {
          setAlarm: async (time: number) => {
            alarm = time;
          },
          deleteAlarm: async () => {
            alarm = null;
          },
          getAlarm: async () => alarm,
        },
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  server(handler, undefined as never);
  if (!captured) throw new Error('engine not captured');
  return { engine: captured, getAlarm: () => alarm };
}

describe('inbox() on a channel — writes real per-member rows on broadcast', () => {
  it('writes an undelivered row for a member of a channel that lists inbox() in its own capabilities', async () => {
    const base = define({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const chat = base.channel('chat', { capabilities: [inbox()] });
    const plain = base.channel('plain', {});
    const handler = base.assemble({ handlers: [chat, plain] });
    const { engine } = buildEngine(handler);
    await engine.initialize();

    const core = engine.core;
    persistMembership(core, { userId: 'alice', channelName: 'chat', channelFamily: null });
    persistMembership(core, { userId: 'alice', channelName: 'plain', channelFamily: null });

    core.inboxService!.fanOut(core, {
      channelName: 'chat',
      channelFamily: null,
      event: 'room-msg',
      payload: { text: 'hi' },
      seq: 1,
      messageId: 'm1',
    });

    const rows = loadUndeliveredRows(core.storage.sql, 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelName: 'chat', event: 'room-msg', seq: 1 });
  });

  it('writes no row for the same member on a channel that does not list inbox()', async () => {
    const base = define({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const chat = base.channel('chat', { capabilities: [inbox()] });
    const plain = base.channel('plain', {});
    const handler = base.assemble({ handlers: [chat, plain] });
    const { engine } = buildEngine(handler);
    await engine.initialize();

    const core = engine.core;
    persistMembership(core, { userId: 'alice', channelName: 'plain', channelFamily: null });

    core.inboxService!.fanOut(core, {
      channelName: 'plain',
      channelFamily: null,
      event: 'room-msg',
      payload: { text: 'hi' },
      seq: 1,
      messageId: 'm1',
    });

    expect(loadUndeliveredRows(core.storage.sql, 'alice')).toHaveLength(0);
  });
});

describe('quiet inbox retention uses the shared durable alarm', () => {
  it('removes rows and gap watermarks for a scope removed by the next boot', async () => {
    const base = define({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const firstChat = base.channel('chat', { capabilities: [inbox()] });
    const firstLegacy = base.channel('legacy', { capabilities: [inbox()] });
    const storage = createTestStorage();
    const first = buildEngine(base.assemble({ handlers: [firstChat, firstLegacy] }), storage);
    await first.engine.initialize();

    insertInboxRows(storage.sql, {
      userIds: ['alice'],
      channelName: 'legacy',
      channelFamily: null,
      frame: { seq: 1, messageId: 'legacy-1', event: 'old', payload: {} },
      now: 1,
    });
    bumpInboxWatermark(storage.sql, {
      userId: 'alice',
      channelName: 'legacy',
      channelFamily: null,
      evictedThroughSeq: 1,
    });
    advanceReceivedThrough(storage.sql, {
      channelName: 'legacy',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 1,
      now: 1,
    });
    advanceReadThrough(storage.sql, {
      channelName: 'legacy',
      channelFamily: null,
      userId: 'alice',
      readThrough: 1,
      now: 1,
    });

    const secondChat = base.channel('chat', { capabilities: [inbox()] });
    const second = buildEngine(base.assemble({ handlers: [secondChat] }), storage);
    await second.engine.initialize();

    expect(loadUndeliveredRows(storage.sql, 'alice')).toEqual([]);
    expect(loadInboxWatermarks(storage.sql, 'alice')).toEqual([]);
    expect(
      listReceivers(storage.sql, { channelName: 'legacy', channelFamily: null, seq: 1 }),
    ).toEqual([]);
    expect(
      listReaders(storage.sql, { channelName: 'legacy', channelFamily: null, seq: 1 }),
    ).toEqual([]);
  });

  it('reconciles a changed count cap on boot without creating an age alarm', async () => {
    const base = define({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const firstChat = base.channel('chat', {
      capabilities: [inbox({ retention: { maxMessages: 3 } })],
    });
    const firstHandler = base.assemble({ handlers: [firstChat] });
    const storage = createTestStorage();
    const first = buildEngine(firstHandler, storage);
    await first.engine.initialize();

    insertInboxRows(storage.sql, {
      userIds: ['alice'],
      channelName: 'chat',
      channelFamily: null,
      frame: { seq: 1, messageId: 'm1', event: 'room-msg', payload: {} },
      now: 1,
    });
    insertInboxRows(storage.sql, {
      userIds: ['alice'],
      channelName: 'chat',
      channelFamily: null,
      frame: { seq: 2, messageId: 'm2', event: 'room-msg', payload: {} },
      now: 2,
    });

    const secondChat = base.channel('chat', {
      capabilities: [inbox({ retention: { maxMessages: 1 } })],
    });
    const secondHandler = base.assemble({ handlers: [secondChat] });
    const second = buildEngine(secondHandler, storage);
    await second.engine.initialize();

    expect(loadUndeliveredRows(storage.sql, 'alice').map((row) => row.seq)).toEqual([2]);
    expect(second.getAlarm()).toBeNull();
  });

  it('expires rows after the age window, preserves the gap, and coexists with scheduled work', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const base = define({
        capabilities: [
          channels(),
          sequence({ persist: true }),
          dedup(),
          scheduled({ tick: { every: 1_000 } }),
        ],
      });
      const chat = base.channel('chat', {
        capabilities: [inbox({ retention: { maxAgeMs: 20 } })],
      });
      base.scheduled('tick', { run() {} });
      const handler = base.assemble({ handlers: [chat] });
      const { engine, getAlarm } = buildEngine(handler);
      await engine.initialize();

      const core = engine.core;
      persistMembership(core, { userId: 'alice', channelName: 'chat', channelFamily: null });
      core.inboxService!.fanOut(core, {
        channelName: 'chat',
        channelFamily: null,
        event: 'room-msg',
        payload: { text: 'quiet' },
        seq: 1,
        messageId: 'm1',
      });

      expect(getAlarm()).toBe(1_021);

      vi.setSystemTime(1_020);
      await engine.handleAlarm();
      expect(loadUndeliveredRows(core.storage.sql, 'alice').map((row) => row.seq)).toEqual([1]);
      expect(getAlarm()).toBe(1_021);

      vi.setSystemTime(1_021);
      await engine.handleAlarm();
      expect(loadUndeliveredRows(core.storage.sql, 'alice')).toEqual([]);
      expect(loadInboxWatermarks(core.storage.sql, 'alice')).toEqual([
        { channelName: 'chat', channelFamily: null, evictedThroughSeq: 1 },
      ]);
      // The recurring scheduled task remains queued; the inbox source did not
      // clear or replace its alarm slot.
      expect(getAlarm()).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('chooses the earliest deadline across static and dynamic inbox scopes', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const base = define({
        capabilities: [channels(), sequence({ persist: true }), dedup()],
      });
      const chat = base.channel('chat', {
        capabilities: [inbox({ retention: { maxAgeMs: 20 } })],
      });
      const rooms = base.channel(['rooms', 'room:{id}'], {
        membership: 'persistent',
        capabilities: [inbox({ retention: { maxAgeMs: 100 } })],
      });
      const handler = base.assemble({ handlers: [chat, rooms] });
      const { engine, getAlarm } = buildEngine(handler);
      await engine.initialize();

      const core = engine.core;
      persistMembership(core, { userId: 'alice', channelName: 'chat', channelFamily: null });
      persistMembership(core, {
        userId: 'bob',
        channelName: 'room:one',
        channelFamily: 'rooms',
      });
      core.inboxService!.fanOut(core, {
        channelName: 'chat',
        channelFamily: null,
        event: 'room-msg',
        payload: { text: 'static' },
        seq: 1,
        messageId: 'static-1',
      });
      core.inboxService!.fanOut(core, {
        channelName: 'room:one',
        channelFamily: 'rooms',
        event: 'room-msg',
        payload: { text: 'dynamic' },
        seq: 2,
        messageId: 'dynamic-1',
      });

      expect(getAlarm()).toBe(1_021);

      vi.setSystemTime(1_021);
      await engine.handleAlarm();
      expect(loadUndeliveredRows(core.storage.sql, 'alice')).toEqual([]);
      expect(loadUndeliveredRows(core.storage.sql, 'bob').map((row) => row.seq)).toEqual([2]);
      expect(getAlarm()).toBe(1_101);

      vi.setSystemTime(1_101);
      await engine.handleAlarm();
      expect(loadUndeliveredRows(core.storage.sql, 'bob')).toEqual([]);
      expect(loadInboxWatermarks(core.storage.sql, 'alice')).toEqual([
        { channelName: 'chat', channelFamily: null, evictedThroughSeq: 1 },
      ]);
      expect(loadInboxWatermarks(core.storage.sql, 'bob')).toEqual([
        { channelName: 'room:one', channelFamily: 'rooms', evictedThroughSeq: 2 },
      ]);
      expect(getAlarm()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a host missing sequence()/dedup() fails the build, naming what to add and where', () => {
  it('fails when a channel lists inbox() but the host is missing sequence() and dedup()', () => {
    const base = define({ capabilities: [channels()] });
    const chat = base.channel('chat', { capabilities: [inbox()] });
    expect(() => base.assemble({ handlers: [chat] })).toThrow(
      '[wskit] The sequence() capability is required by inbox but is not listed. Add sequence() to define({ capabilities: [...] }).',
    );
  });

  it('fails when a channel lists inbox() but the host — a plain app, no plugin involved — is missing channels()', () => {
    // base.channel() itself gates on channels() being listed before a channel
    // can even be built, so this throws earlier than resolveCapabilityRequirements
    // — but it proves the same thing: a non-plugin app still needs channels()
    // listed, with no plugin around to have satisfied the requirement for it.
    const base = define({
      capabilities: [sequence({ persist: true }), dedup()],
    });
    const escapeHatch = base as unknown as { channel(name: string, config?: unknown): unknown };
    expect(() => escapeHatch.channel('chat', { capabilities: [inbox()] })).toThrow(
      '[wskit] base.channel() needs the channels() capability. Add channels() to capabilities.',
    );
  });
});
