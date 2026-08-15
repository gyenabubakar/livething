import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { dispatchRuntime } from '~/_engine/engine.deps.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { bench, describe } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerContract, ServerDefinition } from '~/server-definition.ts';

type AnyServerDefinition = ServerDefinition<readonly Primitive[], ServerContract, unknown, unknown>;

const TickInput = v.object({ n: v.number() });

async function makeEngine(handler: AnyServerDefinition): Promise<Engine> {
  let engine: Engine | undefined;
  const server = adapter({
    id: 'bench',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql: createTestSql(), kv: createTestKV() },
        env: {},
        platform: {},
        timers: createTestTimers(),
        waitUntil: () => {},
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  server(handler, {} as never);
  await engine!.initialize();
  return engine!;
}

function createConnection(): RuntimeConnection {
  return {
    id: 'c1',
    userId: 'c1',
    wsKey: Symbol('c1'),
    descriptor: {
      send() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: 'c1',
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

/** A handler with nothing listed — the smallest context the engine ever builds. */
function bareHandler(): AnyServerDefinition {
  const base = define({ env: t<Record<string, never>>() });
  return base.assemble({
    handlers: [base.on('tick', { input: TickInput, run() {} })],
  }) as AnyServerDefinition;
}

/**
 * A handler listing `channels()` and `tags()`, so the context carries every
 * accessor the engine can attach (`connectionCount`, `bufferedAmount`,
 * `channels`, `tags`). This is the shape a real app builds on every frame.
 */
function fullHandler(): AnyServerDefinition {
  const base = define({
    env: t<Record<string, never>>(),
    capabilities: [channels(), tags((ephemeral) => [ephemeral('team', t<string>())])],
  });
  const room = base.channel('room', { membership: 'ephemeral' });
  return base.assemble({
    handlers: [
      base.on('tick', { input: TickInput, run() {} }),
      room.on('tick', { input: TickInput, run() {} }),
    ],
  }) as AnyServerDefinition;
}

const bareCore = (await makeEngine(bareHandler())).core;
const fullCore = (await makeEngine(fullHandler())).core;

const buildBare = dispatchRuntime(bareCore).buildConnectionContext;
const buildFull = dispatchRuntime(fullCore).buildConnectionContext;
const connection = createConnection();
const roomScope = {
  channel: fullCore.compiled.channels.get('room')!,
  channelName: 'room',
  channelFamily: null,
};

describe('buildConnectionContext', () => {
  // The common case — a handler that only touches send / payload / meta.
  bench('build — bare handler', () => {
    buildBare(connection);
  });

  // Every accessor attached: connectionCount, bufferedAmount, channels, tags.
  bench('build — channels + tags listed', () => {
    buildFull(connection);
  });

  // A channel-scoped frame also builds `ctx.channel`.
  bench('build — channel-scoped', () => {
    buildFull(connection, roomScope);
  });

  // Forces the deferred buildChannelsApi, simulating a build that runs
  // unconditionally on every message.
  bench('build + access ctx.channels', () => {
    const ctx = buildFull(connection) as Record<string, unknown>;
    void ctx.channels;
  });

  // Reads through the accessors the way a handler body does.
  bench('build + read connectionCount and bufferedAmount', () => {
    const ctx = buildFull(connection) as Record<string, unknown>;
    void ctx.connectionCount;
    void ctx.bufferedAmount;
  });
});

// A dispatch with 3 intercepts: compares one shared context against a fresh
// context built for each intercept plus the handler (4 builds).
describe('context builds for a 3-intercept dispatch', () => {
  bench('one shared context', () => {
    buildFull(connection);
  });

  bench('a fresh context per intercept + handler', () => {
    for (let i = 0; i < 4; i++) {
      buildFull(connection);
    }
  });
});
