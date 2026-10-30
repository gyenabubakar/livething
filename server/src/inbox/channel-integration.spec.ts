import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { engineAccessDeps } from '~/_engine/engine.deps.ts';
import { createEngineAccess } from '~/_engine/registry/engine-access.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { channels } from '~/channel/capability.ts';
import { persistMembership } from '~/channel/membership.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
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
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { inbox } from './capability.ts';
import {
  advanceReadThrough,
  advanceReceivedThrough,
  listReaders,
  listReceivers,
} from './receipts-storage.ts';
import { applyInboxAck, drainInboxOnReconnect } from './runtime.ts';
import { buildInboxSurface } from './surface.ts';

function buildEngine(
  definition: ServerDefinition,
  storage = createTestStorage(),
): { engine: Engine; getAlarm: () => number | null } {
  let captured: Engine | undefined;
  let alarm: number | null = null;
  const runAdapter = adapter({
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
        },
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return { engine: captured, getAlarm: () => alarm };
}

describe('inbox() on a channel — writes real per-member rows on broadcast', () => {
  it('writes an undelivered row for a member of a channel that lists inbox() in its own capabilities', async () => {
    const base = server({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const chat = base.channel('chat', { membership: 'persistent', capabilities: [inbox()] });
    const plain = base.channel('plain', {});
    const definition = base.assemble({ handlers: [chat, plain] });
    const { engine } = buildEngine(definition);

    await engine.initialize();

    const core = engine.core;
    persistMembership(core, { userId: 'alice', channelName: 'chat', channelFamily: null });
    persistMembership(core, { userId: 'alice', channelName: 'plain', channelFamily: null });

    core.inboxService!.fanOut(core, {
      channelName: 'chat',
      channelFamily: null,
      event: 'room-msg',
      payload: { text: 'hi' },
      deliverySeq: 1,
      messageId: 'm1',
    });

    const rows = loadUndeliveredRows(core.storage.sql, 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelName: 'chat', event: 'room-msg', seq: 1 });
  });

  it('writes no row for the same member on a channel that does not list inbox()', async () => {
    const base = server({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const chat = base.channel('chat', { membership: 'persistent', capabilities: [inbox()] });
    const plain = base.channel('plain', {});
    const definition = base.assemble({ handlers: [chat, plain] });
    const { engine } = buildEngine(definition);

    await engine.initialize();

    const core = engine.core;
    persistMembership(core, { userId: 'alice', channelName: 'plain', channelFamily: null });

    core.inboxService!.fanOut(core, {
      channelName: 'plain',
      channelFamily: null,
      event: 'room-msg',
      payload: { text: 'hi' },
      deliverySeq: 1,
      messageId: 'm1',
    });

    expect(loadUndeliveredRows(core.storage.sql, 'alice')).toHaveLength(0);
  });
});

describe('quiet inbox retention uses the shared durable alarm', () => {
  it('removes rows and gap watermarks for a scope removed by the next boot', async () => {
    const base = server({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const firstChat = base.channel('chat', { membership: 'persistent', capabilities: [inbox()] });
    const removedChannel = base.channel('removed', {
      membership: 'persistent',
      capabilities: [inbox()],
    });
    const storage = createTestStorage();
    const first = buildEngine(base.assemble({ handlers: [firstChat, removedChannel] }), storage);

    await first.engine.initialize();

    insertInboxRows(storage.sql, {
      userIds: ['alice'],
      channelName: 'removed',
      channelFamily: null,
      frame: { deliverySeq: 1, messageId: 'removed-1', event: 'message', payload: {} },
      now: 1,
    });
    bumpInboxWatermark(storage.sql, {
      userId: 'alice',
      channelName: 'removed',
      channelFamily: null,
      evictedThroughSeq: 1,
    });
    advanceReceivedThrough(storage.sql, {
      channelName: 'removed',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 1,
      now: 1,
    });
    advanceReadThrough(storage.sql, {
      channelName: 'removed',
      channelFamily: null,
      userId: 'alice',
      readThrough: 1,
      now: 1,
    });

    const secondChat = base.channel('chat', { membership: 'persistent', capabilities: [inbox()] });
    const second = buildEngine(base.assemble({ handlers: [secondChat] }), storage);
    await second.engine.initialize();

    expect(loadUndeliveredRows(storage.sql, 'alice')).toEqual([]);
    expect(loadInboxWatermarks(storage.sql, 'alice')).toEqual([]);
    expect(
      listReceivers(storage.sql, { channelName: 'removed', channelFamily: null, seq: 1 }),
    ).toEqual([]);
    expect(
      listReaders(storage.sql, { channelName: 'removed', channelFamily: null, seq: 1 }),
    ).toEqual([]);
  });

  it('reconciles a changed count cap on boot without creating an age alarm', async () => {
    const base = server({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const firstChat = base.channel('chat', {
      membership: 'persistent',
      capabilities: [inbox({ retention: { maxMessages: 3 } })],
    });
    const firstDefinition = base.assemble({ handlers: [firstChat] });
    const storage = createTestStorage();
    const first = buildEngine(firstDefinition, storage);

    await first.engine.initialize();

    insertInboxRows(storage.sql, {
      userIds: ['alice'],
      channelName: 'chat',
      channelFamily: null,
      frame: { deliverySeq: 1, messageId: 'm1', event: 'room-msg', payload: {} },
      now: 1,
    });
    insertInboxRows(storage.sql, {
      userIds: ['alice'],
      channelName: 'chat',
      channelFamily: null,
      frame: { deliverySeq: 2, messageId: 'm2', event: 'room-msg', payload: {} },
      now: 2,
    });

    const secondChat = base.channel('chat', {
      membership: 'persistent',
      capabilities: [inbox({ retention: { maxMessages: 1 } })],
    });
    const secondDefinition = base.assemble({ handlers: [secondChat] });
    const second = buildEngine(secondDefinition, storage);
    await second.engine.initialize();

    expect(loadUndeliveredRows(storage.sql, 'alice').map((row) => row.seq)).toEqual([2]);
    expect(second.getAlarm()).toBeNull();
  });

  it('expires rows after the age window, preserves the gap, and coexists with scheduled work', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const base = server({
        capabilities: [
          channels(),
          sequence({ persist: true }),
          dedup(),
          scheduled({ tick: { every: 1_000 } }),
        ],
      });
      const chat = base.channel('chat', {
        membership: 'persistent',
        capabilities: [inbox({ retention: { maxAgeMs: 20 } })],
      });
      base.scheduled('tick', { run() {} });
      const definition = base.assemble({ handlers: [chat] });
      const { engine, getAlarm } = buildEngine(definition);

      await engine.initialize();

      const core = engine.core;
      persistMembership(core, { userId: 'alice', channelName: 'chat', channelFamily: null });
      core.inboxService!.fanOut(core, {
        channelName: 'chat',
        channelFamily: null,
        event: 'room-msg',
        payload: { text: 'quiet' },
        deliverySeq: 1,
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
      const base = server({
        capabilities: [channels(), sequence({ persist: true }), dedup()],
      });
      const chat = base.channel('chat', {
        membership: 'persistent',
        capabilities: [inbox({ retention: { maxAgeMs: 20 } })],
      });
      const rooms = base.channel(['rooms', 'room:{id}'], {
        membership: 'persistent',
        capabilities: [inbox({ retention: { maxAgeMs: 100 } })],
      });
      const definition = base.assemble({ handlers: [chat, rooms] });
      const { engine, getAlarm } = buildEngine(definition);

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
        deliverySeq: 1,
        messageId: 'static-1',
      });
      core.inboxService!.fanOut(core, {
        channelName: 'room:one',
        channelFamily: 'rooms',
        event: 'room-msg',
        payload: { text: 'dynamic' },
        deliverySeq: 2,
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

/** Drain a member's owed messages, then ack them as the client inbox() primitive does. */
function reconnectAndAck(engine: Engine, userId: string): string[] {
  const texts: string[] = [];
  let receivedThrough = 0;
  const connection = {
    id: `${userId}-socket`,
    userId,
    descriptor: {
      send: (frame: string) => {
        const [event, payload, meta] = JSON.parse(frame) as [
          string,
          { text: string },
          { delivery?: { seq: number } } | null,
        ];
        if (event !== 'message') return;

        texts.push(payload.text);
        receivedThrough = Math.max(receivedThrough, meta?.delivery?.seq ?? 0);
      },
      close() {},
      bufferedAmount: () => 0,
    },
  } as unknown as RuntimeConnection;
  drainInboxOnReconnect(engine.core, connection);
  applyInboxAck(engine.core.storage.sql, {
    userId,
    channelName: 'chat',
    channelFamily: null,
    receivedThrough,
  });

  return texts;
}

async function buildChatEngine(members: readonly string[] = ['ada', 'ben']): Promise<Engine> {
  const base = server({
    capabilities: [channels(), sequence({ persist: true }), dedup()],
  });
  const chat = base.channel('chat', {
    membership: 'persistent',
    capabilities: [emits({ message: t<{ text: string }>() }), inbox()],
  });
  const { engine } = buildEngine(base.assemble({ handlers: [chat] }));
  await engine.initialize();
  for (const userId of members) {
    persistMembership(engine.core, { userId, channelName: 'chat', channelFamily: null });
  }

  return engine;
}

const earlierMessages = [
  { event: 'message', payload: { text: 'old one' }, __livething: { messageId: 'old-1' } },
  { event: 'message', payload: { text: 'old two' }, __livething: { messageId: 'old-2' } },
];

function chatInboxOf(engine: Engine) {
  const access = createEngineAccess(engine.core, engineAccessDeps(engine.core));
  return buildInboxSurface(access, { channelName: 'chat', channelFamily: null });
}

describe('inbox backfill() next to live messages', () => {
  it('keeps live messages sent after a backfill for an offline member', async () => {
    const engine = await buildChatEngine();

    chatInboxOf(engine).backfill('ben', earlierMessages);
    const chat = engine.admin().channels.get('chat');
    chat.broadcast('message', { text: 'live one' });
    chat.broadcast('message', { text: 'live two' });

    expect(reconnectAndAck(engine, 'ben')).toEqual(['old one', 'old two', 'live one', 'live two']);
  });

  it('stores each message once when the same backfill runs twice', async () => {
    const engine = await buildChatEngine();
    const chatInbox = chatInboxOf(engine);

    chatInbox.backfill('ben', earlierMessages);
    chatInbox.backfill('ben', earlierMessages);

    expect(reconnectAndAck(engine, 'ben')).toEqual(['old one', 'old two']);
  });
});

type ChatFrame = [string, { text?: string } | null, { delivery?: { seq?: number } } | null];

/** Open a real connection for one user, as the adapter would, and record what it receives. */
async function connectAs(engine: Engine, userId: string) {
  const frames: ChatFrame[] = [];
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol(userId), {
    send: (data: string) => frames.push(JSON.parse(data) as ChatFrame),
    close() {},
    bufferedAmount: () => 0,
    userId,
  });
  const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
  await connection.lifecycleReady;

  function messages() {
    return frames.filter(([event]) => event === 'message');
  }

  return {
    connection,
    texts: () => messages().map(([, payload]) => payload?.text),
    subscribe: () =>
      handle.handleMessage(JSON.stringify(['__subscribe__', {}, { channel: { name: 'chat' } }])),
    /** Ack the highest seq seen, with the frame the client's inbox() primitive sends. */
    ack: async () => {
      const receivedThrough = Math.max(...messages().map(([, , meta]) => meta?.delivery?.seq ?? 0));
      await handle.handleMessage(
        JSON.stringify(['__received__', { receivedThrough }, { channel: { name: 'chat' } }]),
      );
    },
    close: () => handle.handleClose(1006, 'dropped'),
  };
}

async function untilTrue(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;

    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  throw new Error('condition never became true');
}

function inChat(engine: Engine, connectionId: string): boolean {
  const members = engine.core.channelMembers.get(JSON.stringify([null, 'chat']));
  return [...(members ?? [])].some((connection) => connection.id === connectionId);
}

describe('inbox backfill() for a member who is online', () => {
  it('sends the backfilled messages straight away, so the ack of a later live message loses nothing', async () => {
    const engine = await buildChatEngine();
    const ben = await connectAs(engine, 'ben');
    await ben.subscribe();
    expect(inChat(engine, ben.connection.id)).toBe(true);

    chatInboxOf(engine).backfill('ben', earlierMessages);
    engine.admin().channels.get('chat').broadcast('message', { text: 'live one' });

    expect(ben.texts()).toEqual(['old one', 'old two', 'live one']);
    await ben.ack();
    expect(loadUndeliveredRows(engine.core.storage.sql, 'ben')).toEqual([]);

    await ben.close();
    const benAgain = await connectAs(engine, 'ben');
    await untilTrue(() => inChat(engine, benAgain.connection.id));
    expect(benAgain.texts()).toEqual([]);
  });

  it('sends nothing live when the member is not in the channel, and drains on the next connect', async () => {
    const engine = await buildChatEngine(['ada']);
    const ben = await connectAs(engine, 'ben');

    chatInboxOf(engine).backfill('ben', earlierMessages);
    expect(ben.texts()).toEqual([]);

    persistMembership(engine.core, { userId: 'ben', channelName: 'chat', channelFamily: null });
    await ben.close();
    const benAgain = await connectAs(engine, 'ben');
    await untilTrue(() => benAgain.texts().length === 2);
    expect(benAgain.texts()).toEqual(['old one', 'old two']);
  });

  it('sends nothing new when the same backfill runs again while its messages are still stored', async () => {
    const engine = await buildChatEngine();
    const ben = await connectAs(engine, 'ben');
    await ben.subscribe();
    expect(inChat(engine, ben.connection.id)).toBe(true);
    const chatInbox = chatInboxOf(engine);

    chatInbox.backfill('ben', earlierMessages);
    chatInbox.backfill('ben', earlierMessages);

    expect(ben.texts()).toEqual(['old one', 'old two']);
  });
});

describe('a host missing sequence()/dedup() fails the build, naming what to add and where', () => {
  it('fails when a channel lists inbox() but the host is missing sequence() and dedup()', () => {
    const base = server({ capabilities: [channels()] });
    const chat = base.channel('chat', { membership: 'persistent', capabilities: [inbox()] });
    expect(() => base.assemble({ handlers: [chat] })).toThrow(
      '[livething] The sequence() capability is required by inbox but is not listed. Add sequence() to server({ capabilities: [...] }).',
    );
  });

  it('fails when a channel lists inbox() but the host — a plain app, no plugin involved — is missing channels()', () => {
    // base.channel() itself gates on channels() being listed before a channel
    // can even be built, so this throws earlier than resolveCapabilityRequirements
    // — but it proves the same thing: a non-plugin app still needs channels()
    // listed, with no plugin around to have satisfied the requirement for it.
    const base = server({
      capabilities: [sequence({ persist: true }), dedup()],
    });
    const escapeHatch = base as unknown as { channel(name: string, config?: unknown): unknown };
    expect(() => escapeHatch.channel('chat', { capabilities: [inbox()] })).toThrow(
      '[livething] base.channel() needs the channels() capability. Add channels() to capabilities.',
    );
  });
});
