import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { channelRuntime, dispatchRuntime } from '~/_engine/engine.deps.ts';
import { processTextMessage } from '~/_engine/runtime/messages.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { context } from '~/ambient-context.ts';
import { channels } from '~/channel/capability.ts';
import { removeChannelMembership } from '~/channel/runtime.ts';
import * as ChannelRuntime from '~/channel/runtime.ts';
import { dedup } from '~/dedup/capability.ts';
import { replay } from '~/replay/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { sequence } from '~/sequence/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { inbox, readReceipts } from './capability.ts';

function buildEngine(definition: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'inbox-subscribe-gate-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),

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

function fakeConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    wsKey: Symbol(id),
    descriptor: { send() {}, close() {}, bufferedAmount: () => 0, userId },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

/** Records channel-only and connection-safe surfaces at a given hook. */
interface Sighting {
  hasInbox: boolean;
  hasReadReceipts: boolean;
  hasLookupInbox: boolean;
  hasLookupReadReceipts: boolean;
  hasLookupRequest: boolean;
  hasLookupBroadcastRequest: boolean;
  hasRequest: boolean;
  hasBroadcastRequest: boolean;
  hasRootRequest: boolean;
  hasRootBroadcastRequest: boolean;
  hasRootReplay: boolean;
  hasTagBroadcastRequest: boolean;
  hasStream: boolean;
  hasMembers: boolean;
  hasReplay: boolean;
  hasTags: boolean;
}

function buildHandler() {
  const sightings: Record<'check' | 'commit' | 'revalidate' | 'subscribe', Sighting | undefined> = {
    check: undefined,
    commit: undefined,
    revalidate: undefined,
    subscribe: undefined,
  };

  const handles: {
    gate: Record<string, unknown> | undefined;
    normal: Record<string, unknown> | undefined;
  } = { gate: undefined, normal: undefined };

  const base = server({
    capabilities: [
      channels(),
      sequence({ persist: true }),
      dedup(),
      replay.history(),
      serverRequests(),
      tags((ephemeral) => [ephemeral('role', t<string>())]),
    ],
  });

  function record(key: keyof typeof sightings, ctx: unknown) {
    const channel = (ctx as { channel: Record<string, unknown> }).channel;
    const lookup =
      channel.name === 'chat'
        ? (ctx as { channels: { get(name: string): Record<string, unknown> } }).channels.get('chat')
        : (
            ctx as { channels: { get(family: string, name: string): Record<string, unknown> } }
          ).channels.get('rooms', String(channel.name));
    if (key === 'check') handles.gate = lookup;
    if (key === 'subscribe') handles.normal = lookup;
    sightings[key] = {
      hasInbox: 'inbox' in channel,
      hasReadReceipts: 'readReceipts' in channel,
      hasLookupInbox: 'inbox' in lookup,
      hasLookupReadReceipts: 'readReceipts' in lookup,
      hasLookupRequest: 'request' in lookup,
      hasLookupBroadcastRequest: 'broadcastRequest' in lookup,
      hasRequest: 'request' in channel,
      hasBroadcastRequest: 'broadcastRequest' in channel,
      hasRootRequest: 'request' in (ctx as Record<string, unknown>),
      hasRootBroadcastRequest: 'broadcastRequest' in (ctx as Record<string, unknown>),
      hasRootReplay: typeof (ctx as { sendReplay?: unknown }).sendReplay === 'function',
      hasTagBroadcastRequest:
        'broadcastRequest' in
        (ctx as { tags: { ephemeral(group: string): Record<string, unknown> } }).tags.ephemeral(
          'role',
        ),
      hasStream: 'stream' in (ctx as Record<string, unknown>),
      hasMembers: typeof channel.members === 'function',
      hasReplay: typeof channel.sendReplay === 'function',
      hasTags: 'tags' in (ctx as Record<string, unknown>),
    };
  }

  const chat = base.channel('chat', {
    capabilities: [
      serverRequests({ ask: { out: t<{ prompt: string }>(), in: v.object({ ok: v.boolean() }) } }),
      inbox(),
      readReceipts(),
    ],
    check(ctx) {
      record('check', ctx);
    },
    commit(ctx) {
      record('commit', ctx);
    },
    revalidate(ctx) {
      record('revalidate', ctx);
    },
  });
  chat.subscribe((ctx) => {
    record('subscribe', ctx);
  });

  const definition = base.assemble({ handlers: [chat] });

  return { definition, sightings, handles };
}

function buildDynamicHandler() {
  const sightings: Record<'check' | 'commit' | 'revalidate' | 'subscribe', Sighting | undefined> = {
    check: undefined,
    commit: undefined,
    revalidate: undefined,
    subscribe: undefined,
  };

  const handles: {
    gate: Record<string, unknown> | undefined;
    normal: Record<string, unknown> | undefined;
  } = { gate: undefined, normal: undefined };
  const state = { sightings, handles };

  const base = server({
    capabilities: [
      channels(),
      sequence({ persist: true }),
      dedup(),
      replay.history(),
      serverRequests(),
      tags((ephemeral) => [ephemeral('role', t<string>())]),
    ],
  });

  const rooms = base.channel(['rooms', 'room:{id}'], {
    capabilities: [
      serverRequests({ ask: { out: t<{ prompt: string }>(), in: v.object({ ok: v.boolean() }) } }),
      inbox(),
      readReceipts(),
    ],
    check(ctx) {
      recordDynamic('check', ctx, state);
    },
    commit(ctx) {
      recordDynamic('commit', ctx, state);
    },
    revalidate(ctx) {
      recordDynamic('revalidate', ctx, state);
    },
  });
  rooms.subscribe((ctx) => {
    recordDynamic('subscribe', ctx, state);
  });

  return {
    definition: base.assemble({ handlers: [rooms] }),
    sightings,
    handles,
  };
}

function recordDynamic(
  key: keyof Record<'check' | 'commit' | 'revalidate' | 'subscribe', Sighting | undefined>,
  ctx: unknown,
  state: {
    sightings: Record<'check' | 'commit' | 'revalidate' | 'subscribe', Sighting | undefined>;
    handles: {
      gate: Record<string, unknown> | undefined;
      normal: Record<string, unknown> | undefined;
    };
  },
): void {
  const channel = (ctx as { channel: Record<string, unknown> }).channel;
  const lookup = (
    ctx as { channels: { get(family: string, name: string): Record<string, unknown> } }
  ).channels.get('rooms', String(channel.name));
  if (key === 'check') state.handles.gate = lookup;
  if (key === 'subscribe') state.handles.normal = lookup;
  state.sightings[key] = {
    hasInbox: 'inbox' in channel,
    hasReadReceipts: 'readReceipts' in channel,
    hasLookupInbox: 'inbox' in lookup,
    hasLookupReadReceipts: 'readReceipts' in lookup,
    hasLookupRequest: 'request' in lookup,
    hasLookupBroadcastRequest: 'broadcastRequest' in lookup,
    hasRequest: 'request' in channel,
    hasBroadcastRequest: 'broadcastRequest' in channel,
    hasRootRequest: 'request' in (ctx as Record<string, unknown>),
    hasRootBroadcastRequest: 'broadcastRequest' in (ctx as Record<string, unknown>),
    hasRootReplay: typeof (ctx as { sendReplay?: unknown }).sendReplay === 'function',
    hasTagBroadcastRequest:
      'broadcastRequest' in
      (ctx as { tags: { ephemeral(group: string): Record<string, unknown> } }).tags.ephemeral(
        'role',
      ),
    hasStream: 'stream' in (ctx as Record<string, unknown>),
    hasMembers: typeof channel.members === 'function',
    hasReplay: typeof channel.sendReplay === 'function',
    hasTags: 'tags' in (ctx as Record<string, unknown>),
  };
}

describe('ctx.channel.inbox / ctx.channel.readReceipts across the subscribe lifecycle', () => {
  it('are undefined inside check, commit, and revalidate on a channel with inbox() and readReceipts()', async () => {
    const { definition, sightings, handles } = buildHandler();
    const engine = buildEngine(definition);
    await engine.initialize();

    const core = engine.core;
    const connection = fakeConnection('c1', 'alice');
    core.connections.set(connection.id, connection);

    const runtime = dispatchRuntime(core);
    await processTextMessage(
      runtime,
      connection,
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'chat' } }]),
    );

    expect(sightings.check).toEqual({
      hasInbox: false,
      hasReadReceipts: false,
      hasLookupInbox: false,
      hasLookupReadReceipts: false,
      hasLookupRequest: false,
      hasLookupBroadcastRequest: true,
      hasRequest: false,
      hasBroadcastRequest: false,
      hasRootRequest: true,
      hasRootBroadcastRequest: true,
      hasRootReplay: false,
      hasTagBroadcastRequest: true,
      hasStream: false,
      hasMembers: true,
      hasReplay: true,
      hasTags: true,
    });
    expect(sightings.commit).toEqual({
      hasInbox: false,
      hasReadReceipts: false,
      hasLookupInbox: false,
      hasLookupReadReceipts: false,
      hasLookupRequest: false,
      hasLookupBroadcastRequest: true,
      hasRequest: false,
      hasBroadcastRequest: false,
      hasRootRequest: true,
      hasRootBroadcastRequest: true,
      hasRootReplay: false,
      hasTagBroadcastRequest: true,
      hasStream: false,
      hasMembers: true,
      hasReplay: true,
      hasTags: true,
    });

    // Simulate a reconnect: drop live membership (the durable row from the
    // subscribe above stays), then rejoin. `revalidate` runs instead of `check`.
    removeChannelMembership(core.channelMembers, connection, {
      channelName: 'chat',
      channelFamily: null,
    });
    connection.channelMemberships.delete(ChannelRuntime.createChannelMembershipKey('chat', null));

    const channelDeps = channelRuntime(core);
    await ChannelRuntime.subscribeConnectionAsServer(channelDeps, connection, {
      channelName: 'chat',
      channelFamily: null,
      payload: undefined,
      rejoining: true,
    });

    expect(sightings.revalidate).toEqual({
      hasInbox: false,
      hasReadReceipts: false,
      hasLookupInbox: false,
      hasLookupReadReceipts: false,
      hasLookupRequest: false,
      hasLookupBroadcastRequest: true,
      hasRequest: false,
      hasBroadcastRequest: false,
      hasRootRequest: true,
      hasRootBroadcastRequest: true,
      hasRootReplay: false,
      hasTagBroadcastRequest: true,
      hasStream: false,
      hasMembers: true,
      hasReplay: true,
      hasTags: true,
    });
    expect(handles.gate).not.toBe(handles.normal);
  });

  it('are present inside subscribe on that same channel', async () => {
    const { definition, sightings, handles } = buildHandler();
    const engine = buildEngine(definition);
    await engine.initialize();

    const core = engine.core;
    const connection = fakeConnection('c1', 'alice');
    core.connections.set(connection.id, connection);

    const runtime = dispatchRuntime(core);
    await processTextMessage(
      runtime,
      connection,
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'chat' } }]),
    );

    expect(sightings.subscribe).toEqual({
      hasInbox: true,
      hasReadReceipts: true,
      hasLookupInbox: true,
      hasLookupReadReceipts: true,
      hasLookupRequest: false,
      hasLookupBroadcastRequest: true,
      hasRequest: true,
      hasBroadcastRequest: true,
      hasRootRequest: true,
      hasRootBroadcastRequest: true,
      hasRootReplay: false,
      hasTagBroadcastRequest: true,
      hasStream: false,
      hasMembers: true,
      hasReplay: true,
      hasTags: true,
    });
    expect(handles.gate).not.toBe(handles.normal);
  });

  it('keeps the same gate boundary for dynamic channel families', async () => {
    const { definition, sightings, handles } = buildDynamicHandler();
    const engine = buildEngine(definition);
    await engine.initialize();

    const core = engine.core;
    const connection = fakeConnection('c1', 'alice');
    core.connections.set(connection.id, connection);

    const runtime = dispatchRuntime(core);
    await processTextMessage(
      runtime,
      connection,
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'room:one', family: 'rooms' } }]),
    );

    const gateSighting = {
      hasInbox: false,
      hasReadReceipts: false,
      hasLookupInbox: false,
      hasLookupReadReceipts: false,
      hasLookupRequest: false,
      hasLookupBroadcastRequest: true,
      hasRequest: false,
      hasBroadcastRequest: false,
      hasRootRequest: true,
      hasRootBroadcastRequest: true,
      hasRootReplay: false,
      hasTagBroadcastRequest: true,
      hasStream: false,
      hasMembers: true,
      hasReplay: true,
      hasTags: true,
    };

    expect(sightings.check).toEqual(gateSighting);
    expect(sightings.commit).toEqual(gateSighting);

    removeChannelMembership(core.channelMembers, connection, {
      channelName: 'room:one',
      channelFamily: 'rooms',
    });
    connection.channelMemberships.delete(
      ChannelRuntime.createChannelMembershipKey('room:one', 'rooms'),
    );

    await ChannelRuntime.subscribeConnectionAsServer(channelRuntime(core), connection, {
      channelName: 'room:one',
      channelFamily: 'rooms',
      payload: undefined,
      rejoining: true,
    });

    expect(sightings.revalidate).toEqual(gateSighting);
    expect(sightings.subscribe).toEqual({
      hasInbox: true,
      hasReadReceipts: true,
      hasLookupInbox: true,
      hasLookupReadReceipts: true,
      hasLookupRequest: false,
      hasLookupBroadcastRequest: true,
      hasRequest: true,
      hasBroadcastRequest: true,
      hasRootRequest: true,
      hasRootBroadcastRequest: true,
      hasRootReplay: false,
      hasTagBroadcastRequest: true,
      hasStream: false,
      hasMembers: true,
      hasReplay: true,
      hasTags: true,
    });
    expect(handles.gate).not.toBe(handles.normal);
  });

  it('keeps the gate boundary for a plugin channel regardless of capability order', async () => {
    const pluginBase = server({
      scope: 'plugin',
      capabilities: [
        channels(),
        serverRequests({
          ask: { out: t<{ prompt: string }>(), in: v.object({ ok: v.boolean() }) },
        }),
      ],
    });
    const sightings: Record<'check' | 'commit' | 'revalidate' | 'subscribe', Sighting | undefined> =
      {
        check: undefined,
        commit: undefined,
        revalidate: undefined,
        subscribe: undefined,
      };

    function recordPlugin(key: keyof typeof sightings, ctx: unknown): void {
      const raw = ctx as {
        channel: Record<string, unknown>;
        channels: { get(name: string): Record<string, unknown> };
      };
      const channel = raw.channel;
      const lookup = raw.channels.get('chat');
      sightings[key] = {
        hasInbox: 'inbox' in channel,
        hasReadReceipts: 'readReceipts' in channel,
        hasLookupInbox: 'inbox' in lookup,
        hasLookupReadReceipts: 'readReceipts' in lookup,
        hasLookupRequest: 'request' in lookup,
        hasLookupBroadcastRequest: 'broadcastRequest' in lookup,
        hasRequest: 'request' in channel,
        hasBroadcastRequest: 'broadcastRequest' in channel,
        hasRootRequest: 'request' in (ctx as Record<string, unknown>),
        hasRootBroadcastRequest: 'broadcastRequest' in (ctx as Record<string, unknown>),
        hasRootReplay: typeof (ctx as { sendReplay?: unknown }).sendReplay === 'function',
        hasTagBroadcastRequest: false,
        hasStream: 'stream' in (ctx as Record<string, unknown>),
        hasMembers: typeof channel.members === 'function',
        hasReplay: typeof channel.sendReplay === 'function',
        hasTags: false,
      };
    }

    const room = pluginBase.channel('chat', {
      capabilities: [
        serverRequests({
          ask: { out: t<{ prompt: string }>(), in: v.object({ ok: v.boolean() }) },
        }),
        readReceipts(),
        inbox(),
      ],
      check(ctx) {
        recordPlugin('check', ctx);
      },
      commit(ctx) {
        recordPlugin('commit', ctx);
      },
      revalidate(ctx) {
        recordPlugin('revalidate', ctx);
      },
    });
    room.subscribe((ctx) => {
      recordPlugin('subscribe', ctx);
    });

    const Feed = plugin('acme:gate-feed', {
      definition: pluginBase.assemble({ handlers: [room] }),
    });
    const host = server({
      capabilities: [sequence({ persist: true }), dedup(), Feed()],
    });
    const engine = buildEngine(host.assemble({ handlers: [] }));
    await engine.initialize();

    const core = engine.core;
    const connection = fakeConnection('c1', 'alice');
    core.connections.set(connection.id, connection);
    const channelName = '__acme:gate-feed::chat';
    expect(core.compiled.channels.has(channelName)).toBe(true);

    expect(core.hooks.check.has(channelName)).toBe(true);
    await ChannelRuntime.subscribeConnection(channelRuntime(core), connection, {
      channelName,
      channelFamily: null,
      data: {},
    });

    const gateSighting = {
      hasInbox: false,
      hasReadReceipts: false,
      hasLookupInbox: false,
      hasLookupReadReceipts: false,
      hasLookupRequest: false,
      hasLookupBroadcastRequest: true,
      hasRequest: false,
      hasBroadcastRequest: false,
      hasRootRequest: true,
      hasRootBroadcastRequest: true,
      hasRootReplay: false,
      hasTagBroadcastRequest: false,
      hasStream: false,
      hasMembers: true,
      hasReplay: false,
      hasTags: false,
    };

    expect(sightings.check).toEqual(gateSighting);
    expect(sightings.commit).toEqual(gateSighting);

    removeChannelMembership(core.channelMembers, connection, {
      channelName,
      channelFamily: null,
    });
    connection.channelMemberships.delete(
      ChannelRuntime.createChannelMembershipKey(channelName, null),
    );
    await ChannelRuntime.subscribeConnectionAsServer(channelRuntime(core), connection, {
      channelName,
      channelFamily: null,
      payload: undefined,
      rejoining: true,
    });

    expect(sightings.revalidate).toEqual(gateSighting);
    expect(sightings.subscribe).toEqual({
      ...gateSighting,
      hasInbox: true,
      hasReadReceipts: true,
      hasLookupInbox: true,
      hasLookupReadReceipts: true,
      hasRequest: true,
      hasBroadcastRequest: true,
      hasReplay: false,
    });
  });
});

describe('context.channelGate and context.channelLifecycle across the subscribe lifecycle', () => {
  it('serve check, commit and revalidate through channelGate, and subscribe through channelLifecycle', async () => {
    const base = server({ capabilities: [channels()] });
    const seen: Record<string, unknown> = {};
    // The hooks run later, after `chat` is assigned.
    let chatRef = undefined as unknown as Parameters<typeof context.channelGate>[0];
    const chat = base.channel('chat', {
      check(ctx) {
        seen.check = context.channelGate(chatRef) === ctx;
      },
      commit(ctx) {
        seen.commit = context.channelGate(chatRef) === ctx;
      },
      revalidate(ctx) {
        seen.revalidate = context.channelGate(chatRef) === ctx;
        try {
          context.channelLifecycle(chatRef);
        } catch (error) {
          seen.lifecycleInRevalidate = (error as Error).message;
        }
      },
    });
    chatRef = chat;
    chat.subscribe((ctx) => {
      seen.subscribe = context.channelLifecycle(chatRef) === ctx;
    });

    const engine = buildEngine(base.assemble({ handlers: [chat] }));
    await engine.initialize();
    const core = engine.core;
    const connection = fakeConnection('c1', 'alice');
    core.connections.set(connection.id, connection);

    await processTextMessage(
      dispatchRuntime(core),
      connection,
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'chat' } }]),
    );

    // A reconnect: drop the live membership, then rejoin. `revalidate` runs instead of `check`.
    removeChannelMembership(core.channelMembers, connection, {
      channelName: 'chat',
      channelFamily: null,
    });
    connection.channelMemberships.delete(ChannelRuntime.createChannelMembershipKey('chat', null));
    await ChannelRuntime.subscribeConnectionAsServer(channelRuntime(core), connection, {
      channelName: 'chat',
      channelFamily: null,
      payload: undefined,
      rejoining: true,
    });

    expect(seen).toMatchObject({ check: true, commit: true, subscribe: true, revalidate: true });
    expect(seen.lifecycleInRevalidate).toMatch(/'channelGate' invocation/);
  });
});
