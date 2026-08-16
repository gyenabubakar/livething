import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channelRuntime, dispatchRuntime } from '~/_engine/engine.deps.ts';
import { processTextMessage } from '~/_engine/runtime/messages.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { removeChannelMembership } from '~/channel/runtime.ts';
import * as ChannelRuntime from '~/channel/runtime.ts';
import { dedup } from '~/dedup/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { inbox, readReceipts } from './capability.ts';

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'inbox-subscribe-gate-spec',
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

/** Records whether `ctx.channel.inbox` / `ctx.channel.readReceipts` were present at a given hook. */
interface Sighting {
  hasInbox: boolean;
  hasReadReceipts: boolean;
}

function buildHandler() {
  const sightings: Record<'check' | 'commit' | 'revalidate' | 'subscribe', Sighting | undefined> = {
    check: undefined,
    commit: undefined,
    revalidate: undefined,
    subscribe: undefined,
  };

  const base = define({
    env: t<Record<string, never>>(),
    capabilities: [channels(), sequence({ persist: true }), dedup()],
  });

  function record(key: keyof typeof sightings, ctx: unknown) {
    const channel = (ctx as { channel: Record<string, unknown> }).channel;
    // Every channel handle carries a nullable `inbox()`/`readReceipts()` method
    // (a function) by default. The direct member this test cares about
    // replaces that function with the actual surface object for the owning
    // scope, so "present" means "not a function" here.
    sightings[key] = {
      hasInbox: typeof channel.inbox !== 'function',
      hasReadReceipts: typeof channel.readReceipts !== 'function',
    };
  }

  const chat = base.channel('chat', {
    capabilities: [inbox(), readReceipts()],
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

  const handler = base.assemble({ handlers: [chat] });
  return { handler, sightings };
}

describe('ctx.channel.inbox / ctx.channel.readReceipts across the subscribe lifecycle', () => {
  it('are undefined inside check, commit, and revalidate on a channel with inbox() and readReceipts()', async () => {
    const { handler, sightings } = buildHandler();
    const engine = buildEngine(handler);
    await engine.initialize();

    const core = engine.core;
    const connection = fakeConnection('c1', 'alice');
    core.connections.set(connection.id, connection);

    const runtime = dispatchRuntime(core);
    await processTextMessage(
      runtime,
      connection,
      JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'chat' } }),
    );

    expect(sightings.check).toEqual({ hasInbox: false, hasReadReceipts: false });
    expect(sightings.commit).toEqual({ hasInbox: false, hasReadReceipts: false });

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

    expect(sightings.revalidate).toEqual({ hasInbox: false, hasReadReceipts: false });
  });

  it('are present inside subscribe on that same channel', async () => {
    const { handler, sightings } = buildHandler();
    const engine = buildEngine(handler);
    await engine.initialize();

    const core = engine.core;
    const connection = fakeConnection('c1', 'alice');
    core.connections.set(connection.id, connection);

    const runtime = dispatchRuntime(core);
    await processTextMessage(
      runtime,
      connection,
      JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'chat' } }),
    );

    expect(sightings.subscribe).toEqual({ hasInbox: true, hasReadReceipts: true });
  });
});
