/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Boot round-trip budget. Counts the number of `sql.exec` calls
 * `engine.initialize()` issues for tiny/medium/heavy servers, on cold
 * and warm boots. Locks the budget so an accidental regression (someone
 * adds another `CREATE TABLE IF NOT EXISTS` to a boot hook) fails the
 * test instead of silently shipping.
 *
 * Each `sql.exec` is one round trip to Cloudflare DO storage in production.
 * The bundled multi-statement strings (option A) count as ONE call each.
 * Warm boots re-run every idempotent `bootSchema` hook so a capability added
 * after storage initialization still creates its tables on the next wake.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ConnectionBusy, InternalError } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { beginAlarmDelivery, registerAlarmSource, rescheduleAlarm } from '~/_engine/alarm.ts';
import { connectionRuntime } from '~/_engine/engine.deps.ts';
import { tagRefIndexKey } from '~/_engine/runtime/tag-index.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { insertMembership } from '~/channel/storage.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox } from '~/inbox/capability.ts';
import { replay } from '~/replay/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { cursorStream } from '~/stream-cursor/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import { tags } from '~/tags/capability.ts';
import { insertTag } from '~/tags/storage.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function makeFakeStorage(opts?: { initialized?: boolean }) {
  const calls: string[] = [];
  const storage = createTestStorage({ onExec: (query) => calls.push(query) });

  if (opts?.initialized) {
    // Seed the real initialization marker directly, as if a previous boot
    // already wrote it — this does not count against the round-trip budget.
    storage.sql.exec(
      `
        CREATE TABLE IF NOT EXISTS __livething_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT OR REPLACE INTO __livething_meta (key, value) VALUES ('initialized', '1')
      `,
    );
    calls.length = 0;
  }

  return { storage, calls };
}

function buildEngine(definition: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'roundtrip-bench',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),

        platform: {},
        timers: createTestTimers(),
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      });
      return {};
    },
  });
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

async function initWithFakeStorage(definition: ServerDefinition, warm = false) {
  const { storage, calls } = makeFakeStorage();

  if (warm) {
    // Run a full cold boot first so every schema table and the meta row
    // exist, exactly as a previous boot would have left them. A second,
    // separate engine instance then wakes against the same storage — the
    // real shape of a warm boot after a restart.
    const warmup = buildEngine(definition);
    warmup.core.storage = storage as never;
    await warmup.initialize();
    calls.length = 0;
  }

  const engine = buildEngine(definition);
  engine.core.storage = storage as never;
  await engine.initialize();

  return { execCount: calls.length, calls };
}

const Empty = v.object({});
const Text = v.object({ text: v.string() });
const NumChunk = t<{ n: number }>();

const EmptyOut = t<Record<string, never>>();
const TextOut = t<{ text: string }>();

const tinyBase = server({
  capabilities: [emits({ notify: EmptyOut })],
});
const tinyDefinition = tinyBase.assemble({
  handlers: [tinyBase.on('noop', { input: Empty, run() {} })],
});

const alarmBase = server({
  capabilities: [scheduled({ noop: null })],
});
alarmBase.scheduled('noop', { run() {} });
const alarmDefinition = alarmBase.assemble({
  handlers: [],
});

const mediumBase = server({
  hibernation: { enabled: true },
  capabilities: [
    clientRequests(),
    stream(),
    channels(),
    emits({ notify: EmptyOut, joined: EmptyOut }),
  ],
});
const mediumLobby = mediumBase.channel('lobby', { capabilities: [emits({ said: TextOut })] });
mediumLobby.on('say', { input: Text, run() {} });
const mediumRooms = mediumBase.channel(['rooms', 'room:{id}'], {
  capabilities: [emits({ posted: TextOut })],
});
mediumRooms.on('post', { input: Text, run() {} });
const mediumDefinition = mediumBase.assemble({
  handlers: [
    mediumBase.on('join', { input: Empty, run() {} }),
    mediumBase.on('leave', { input: Empty, run() {} }),
    mediumBase.on('noop', { input: Empty, run() {} }),
    mediumBase.request('whoami', {
      input: Empty,
      run(ctx) {
        return { id: ctx.user.id };
      },
    }),
    mediumBase.stream('tail', {
      input: Empty,
      chunk: NumChunk,
      async *run() {
        yield { n: 1 };
      },
    }),
    mediumLobby,
    mediumRooms,
  ],
});

function channelEmits(prefix: string) {
  return {
    [`${prefix}-message`]: TextOut,
    [`${prefix}-edited`]: TextOut,
  };
}

const heavyBase = server({
  hibernation: { enabled: true },
  capabilities: [
    dedup(),
    sequence({ persist: true }),
    replay.history(),
    clientRequests(),
    stream(),
    cursorStream(),
    recordedStream(),
    channels(),
    emits({ 'o-a': EmptyOut, 'o-b': EmptyOut, 'o-c': EmptyOut, 'o-d': EmptyOut, 'o-e': EmptyOut }),
  ],
});

const heavyHandlers: any[] = [];
for (const name of ['a', 'b', 'c', 'd', 'e']) {
  heavyHandlers.push(heavyBase.on(name, { input: Empty, run() {} }));
}

for (const name of ['r-a', 'r-b', 'r-c']) {
  heavyHandlers.push(
    heavyBase.request(name, {
      input: Empty,
      run() {
        return {};
      },
    }),
  );
}

for (const name of ['s-a', 's-b']) {
  heavyHandlers.push(
    heavyBase.stream(name, {
      input: Empty,
      chunk: NumChunk,
      async *run() {
        yield { n: 1 };
      },
    }),
  );
}

heavyHandlers.push(
  heavyBase.cursorStream('rs-a', {
    input: Empty,
    chunk: NumChunk,
    async *run() {
      yield { n: 1 };
    },
  }),
);
heavyHandlers.push(
  heavyBase.recordedStream('rec-a', {
    input: Empty,
    chunk: NumChunk,
    async *run() {
      yield { n: 1 };
    },
  }),
);
for (const n of [1, 2, 3, 4, 5]) {
  const ch = heavyBase.channel(`chan-${n}`, { capabilities: [emits(channelEmits(`c${n}`))] });
  ch.on(`c${n}-send`, { input: Text, run() {} });
  ch.on(`c${n}-edit`, { input: Text, run() {} });
  heavyHandlers.push(ch);
}

for (const n of [1, 2, 3, 4, 5]) {
  const ch = heavyBase.channel([`rooms-${n}`, `r${n}:{id}`], {
    capabilities: [emits(channelEmits(`r${n}`))],
  });
  ch.on(`r${n}-send`, { input: Text, run() {} });
  ch.on(`r${n}-edit`, { input: Text, run() {} });
  heavyHandlers.push(ch);
}

const heavyDefinition = heavyBase.assemble({ handlers: [...heavyHandlers] });

describe('engine.initialize — sql.exec round-trip budget', () => {
  it('tiny (no schema features): cold boot issues 0 exec calls', async () => {
    const { execCount } = await initWithFakeStorage(tinyDefinition);
    expect(execCount).toBe(0);
  });

  it('medium (channels + hibernation): cold boot exec budget', async () => {
    const { execCount, calls } = await initWithFakeStorage(mediumDefinition);
    if (execCount !== 6) {
      // eslint-disable-next-line no-console
      console.log(
        '[medium cold] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }

    // 1 sentinel SELECT + 2 schema hooks (channel membership, hibernation) +
    // 1 hibernation-column check + 1 mark + 1 cleanup (channel membership reconcile SELECT). No
    // replay/sequence/scheduled.
    expect(execCount).toBe(6);
  });

  it('medium: WARM boot re-runs the schema hooks and skips the marker write', async () => {
    const { execCount, calls } = await initWithFakeStorage(mediumDefinition, true);
    if (execCount !== 5) {
      // eslint-disable-next-line no-console
      console.log(
        '[medium warm] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }

    // 1 marker SELECT (returns a row, so storage is not fresh and the marker
    // write is skipped) + 2 schema hooks (connections, channel membership) +
    // 1 hibernation-column check + 1 cleanup (channel membership reconcile).
    // The schema hooks run on every boot so a capability added later still gets its tables.
    expect(execCount).toBe(5);
  });

  it('heavy (channels + hibernation + replay + sequence + scheduled): cold boot exec budget', async () => {
    const { execCount, calls } = await initWithFakeStorage(heavyDefinition);
    if (execCount !== 16) {
      // eslint-disable-next-line no-console
      console.log(
        '[heavy cold] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }

    // Breakdown:
    //   1. sentinel SELECT (throws — no table yet)
    //   2-8. seven schema hooks: alarm retries, channel membership, connections
    //        (hibernation), sequence, replay, durable streams, scheduled
    //   9. suspend durable streams a stopped process left active
    //   10. translator-state column check for hibernation migrations
    //   11. mark sentinel (bundled CREATE meta + INSERT)
    //   12. load any durable framework alarm retry
    //   13. channel membership reconcile (cleanup SELECT)
    //   14-16. scheduled bootstrap loads queued runs + dlq + stopped recurring tasks
    //   17. scheduled persist-after-restore — one INSERT for the new recurring
    //       run added by ensureRecurringRuns. The diff-based persist only
    //       writes genuine new rows, so the empty-load case costs zero extra
    //       writes.
    //
    // The durable-stream schema hook is why a server declaring a durable stream
    // pays two statements more here than the other capabilities alone would cost.
    // Creating those tables at boot rather than on first stream use is what lets
    // purgeUser delete stream rows on a server whose streams have never run —
    // the tables exist either way.
    //
    // The cursorStream()/recordedStream() capabilities install an internal
    // recurring '__livething:stream-durable-sweep' task whenever a server declares a
    // durable stream. That task boots the scheduled engine, which adds the schema
    // hook (#8), the bootstrap loads (#14-16), and the one persist-after-restore
    // INSERT (#17) — so a durable-stream server pays 17 round trips on a cold boot.
    expect(execCount).toBe(17);
  });

  it('heavy: WARM boot re-runs every schema hook', async () => {
    const { execCount, calls } = await initWithFakeStorage(heavyDefinition, true);
    if (execCount !== 15) {
      // eslint-disable-next-line no-console
      console.log(
        '[heavy warm] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }

    // Breakdown:
    //   1. marker SELECT (returns a row, so the marker write is skipped)
    //   2-8. every schema hook: alarm retries, connections, sequence, replay,
    //        foreign keys, channel membership, scheduled
    //   9. suspend durable streams a stopped process left active
    //   10. translator-state column check for hibernation migrations
    //   11. load any durable framework alarm retry
    //   12. channel membership reconcile (cleanup SELECT)
    //   13-15. scheduled bootstrap loads queued runs + dlq + stopped recurring tasks
    //
    // The schema hooks run on every boot rather than being skipped by a
    // warm-boot gate, so a capability added after this storage was first
    // initialized still gets its tables. The recurring
    // '__livething:stream-durable-sweep' task (installed whenever a server
    // declares a durable stream) was already persisted during the cold boot
    // that seeded this storage, so the bootstrap finds it in the loaded rows
    // and issues no extra persist write.
    expect(execCount).toBe(15);
  });
});

describe('engine.initialize — freshBoot only on a truly empty DB', () => {
  async function initAndGetEngine(opts?: { initialized?: boolean }) {
    const { storage } = makeFakeStorage(opts);
    const engine = buildEngine(mediumDefinition);
    engine.core.storage = storage as never;
    await engine.initialize();

    return engine;
  }

  it('sets freshBoot on a cold boot with no prior schema', async () => {
    const engine = await initAndGetEngine();
    expect(engine.core.freshBoot).toBe(true);
  });

  it('does NOT set freshBoot on initialized storage', async () => {
    const engine = await initAndGetEngine({ initialized: true });
    expect(engine.core.freshBoot).toBe(false);
  });
});

describe('engine.handleAlarm — shared source failure does not starve later hooks', () => {
  it('restores a failed alarm cycle retry after restarting during delivery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const storage = createTestStorage();
    const timers = createTestTimers();

    try {
      const first = buildEngine(alarmDefinition);
      first.core.storage = storage;
      first.core.timers = timers;
      await first.initialize();
      first.core.hooks.alarm.push(async () => {
        throw new Error('plugin alarm failed');
      });

      await first.handleAlarm();
      expect(await timers.getAlarm()).toBe(41_000);
      beginAlarmDelivery(first.core);

      const restarted = buildEngine(alarmDefinition);
      restarted.core.storage = storage;
      restarted.core.timers = timers;
      await restarted.initialize();

      expect(await timers.getAlarm()).toBe(41_000);
    } finally {
      storage.db.close();
      vi.useRealTimers();
    }
  });

  it('keeps an earlier source deadline when a failed hook requests a later retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const engine = buildEngine(tinyDefinition);

    try {
      await engine.initialize();

      const scheduledDeadline = 10_250;
      registerAlarmSource(engine.core, Symbol('scheduled'), () => scheduledDeadline);
      engine.core.hooks.alarm.push(async () => {
        throw new Error('inbox cleanup failed');
      });

      await engine.handleAlarm();

      expect(await engine.core.timers.getAlarm()).toBe(scheduledDeadline);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off an overdue failed source instead of immediately rearming it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const engine = buildEngine(tinyDefinition);

    try {
      await engine.initialize();

      registerAlarmSource(engine.core, Symbol('overdue'), () => 19_900);
      engine.core.hooks.alarm.push(async () => {
        throw new Error('scheduled storage failed');
      });

      await engine.handleAlarm();

      expect(await engine.core.timers.getAlarm()).toBe(21_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rearm a consumed retry when a successful hook reschedules', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const engine = buildEngine(tinyDefinition);

    try {
      await engine.initialize();

      let shouldFail = true;
      engine.core.hooks.alarm.push(async () => {
        if (shouldFail) throw new Error('cleanup failed');

        await rescheduleAlarm(engine.core);
      });

      await engine.handleAlarm();
      expect(await engine.core.timers.getAlarm()).toBe(31_000);

      shouldFail = false;
      vi.setSystemTime(31_000);
      const setAlarm = vi.spyOn(engine.core.timers, 'setAlarm');
      setAlarm.mockClear();

      await engine.handleAlarm();

      expect(setAlarm).not.toHaveBeenCalled();
      expect(await engine.core.timers.getAlarm()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs every alarm hook, then schedules its own retry', async () => {
    const engine = buildEngine(tinyDefinition);
    await engine.initialize();

    const events: string[] = [];
    const failure = new Error('retention storage temporarily unavailable');
    engine.core.hooks.alarm.push(async () => {
      events.push('inbox');
      throw failure;
    });
    engine.core.hooks.alarm.push(async () => {
      events.push('scheduled');
    });

    const setAlarm = vi.spyOn(engine.core.timers, 'setAlarm');
    const before = Date.now();
    await expect(engine.handleAlarm()).resolves.toBeUndefined();
    expect(events).toEqual(['inbox', 'scheduled']);
    expect(setAlarm).toHaveBeenCalledWith(expect.any(Number));

    expect(setAlarm.mock.calls.at(-1)?.[0]).toBeGreaterThanOrEqual(before + 1_000);
  });

  it('rejects when the retry deadline cannot be persisted', async () => {
    const engine = buildEngine(tinyDefinition);
    await engine.initialize();

    engine.core.hooks.alarm.push(async () => {
      throw new Error('scheduled work failed');
    });
    const retryFailure = new Error('retry write failed');
    vi.spyOn(engine.core.timers, 'setAlarm').mockRejectedValueOnce(retryFailure);

    await expect(engine.handleAlarm()).rejects.toBe(retryFailure);
  });
});

describe('engine declaredErrorCodes', () => {
  it('includes the internal-error fallback code', () => {
    const engine = buildEngine(tinyDefinition);
    expect(engine.core.declaredErrorCodes.has(InternalError.code)).toBe(true);
  });

  it('includes built-in connection-busy errors', () => {
    const engine = buildEngine(tinyDefinition);
    expect(engine.core.declaredErrorCodes.has(ConnectionBusy.code)).toBe(true);
  });
});

describe('revalidate requires a persistent channel', () => {
  const channelCapabilities = { capabilities: [emits({ said: TextOut })] };

  it("throws at boot when a `membership: 'ephemeral'` channel has a .revalidate() hook", async () => {
    const base = server({
      capabilities: [channels()],
    });
    const room = base.channel('room', {
      ...channelCapabilities,
      membership: 'ephemeral',
      revalidate() {},
    });
    const definition = base.assemble({ handlers: [room] });

    await expect(initWithFakeStorage(definition)).rejects.toThrow(
      /Channel "room" has a \.revalidate\(\) hook but is not persistent/,
    );
  });

  it('boots fine when a persistent channel has a .revalidate() hook', async () => {
    const base = server({
      capabilities: [channels()],
    });
    const room = base.channel('room', { ...channelCapabilities, revalidate() {} });
    const definition = base.assemble({ handlers: [room] });

    await expect(initWithFakeStorage(definition)).resolves.toBeDefined();
  });
});

describe('inbox requires a persistent channel', () => {
  const channelOutgoing = { capabilities: [emits({ said: TextOut })] };

  it("throws at boot when a `membership: 'ephemeral'` channel has inbox()", async () => {
    const base = server({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const room = base.channel('room', {
      ...channelOutgoing,
      membership: 'ephemeral',
      capabilities: [inbox()],
    });
    const definition = base.assemble({ handlers: [room] });

    await expect(initWithFakeStorage(definition)).rejects.toThrow(
      /Channel "room" has inbox\(\) but is not persistent/,
    );
  });

  it('boots fine when a persistent channel has inbox()', async () => {
    const base = server({
      capabilities: [channels(), sequence({ persist: true }), dedup()],
    });
    const room = base.channel('room', { capabilities: [emits({ said: TextOut }), inbox()] });
    const definition = base.assemble({ handlers: [room] });

    await expect(initWithFakeStorage(definition)).resolves.toBeDefined();
  });
});

describe('tags() restores persistent tags on reconnect', () => {
  function fakeConnection(id: string, userId: string): EngineRuntimeTypes.RuntimeConnection {
    return {
      id,
      userId,
      wsKey: {},
      descriptor: { send() {}, close() {}, bufferedAmount: () => 0 },
      meta: {},
      tags: { ephemeral: new Map(), persistent: new Map() },
      channelMemberships: new Map(),
      latency: null,
      quality: 'good',
    } as unknown as EngineRuntimeTypes.RuntimeConnection;
  }

  /** A warm boot (initialized storage present) creates real tables and leaves `freshBoot` false. */
  async function bootWarm(definition: ServerDefinition): Promise<Engine> {
    const { storage } = makeFakeStorage({ initialized: true });
    const engine = buildEngine(definition);
    engine.core.storage = storage as never;
    await engine.initialize();

    return engine;
  }

  it('restores a persistent tag on reconnect even with no channels() capability', async () => {
    const base = server({
      capabilities: [tags((_ephemeral, persistent) => [persistent('role', t<string>())])],
    });
    const definition = base.assemble({
      handlers: [base.on('noop', { input: v.object({}), run() {} })],
    });
    const engine = await bootWarm(definition);

    // A previous session already ran `ctx.tags.persistent('role').add('admin')` —
    // the row is durable, but no live connection carries it yet.
    insertTag(engine.core.storage.sql, { userId: 'u-1', group: 'role', key: 'admin' });

    const connection = fakeConnection('c-1', 'u-1');
    await connectionRuntime(engine.core).autoRejoinIdentity(connection);

    const members = engine.core.tagMembers.get(tagRefIndexKey('persistent', 'role', 'admin'));
    expect(members?.has(connection)).toBe(true);
    expect(connection.tags.persistent.get('role')?.has('admin')).toBe(true);
  });

  it('restores exactly once when both tags() and channels() are listed', async () => {
    const base = server({
      capabilities: [
        tags((_ephemeral, persistent) => [persistent('role', t<string>())]),
        channels(),
      ],
    });
    const room = base.channel('room', { capabilities: [emits({ said: t<{ text: string }>() })] });
    const definition = base.assemble({ handlers: [room] });
    const engine = await bootWarm(definition);

    insertTag(engine.core.storage.sql, { userId: 'u-1', group: 'role', key: 'admin' });
    insertMembership(engine.core.storage.sql, {
      userId: 'u-1',
      channelName: 'room',
      channelFamily: null,
    });

    const calls: unknown[] = [];
    const original = engine.core.tagPersistenceService!.restorePersistentTags;
    engine.core.tagPersistenceService = {
      restorePersistentTags: (opts) => {
        calls.push(opts);
        return original(opts);
      },
    };

    const connection = fakeConnection('c-1', 'u-1');
    engine.core.connections.set(connection.id, connection);
    await connectionRuntime(engine.core).autoRejoinIdentity(connection);

    expect(calls).toHaveLength(1);
    const members = engine.core.tagMembers.get(tagRefIndexKey('persistent', 'role', 'admin'));
    expect(members?.has(connection)).toBe(true);
  });
});

function fakeConnection(id: string, userId: string): EngineRuntimeTypes.RuntimeConnection {
  return {
    id,
    userId,
    wsKey: {},
    descriptor: { send() {}, close() {}, bufferedAmount: () => 0 },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  } as unknown as EngineRuntimeTypes.RuntimeConnection;
}

describe('a capability added after storage was already initialized', () => {
  it("creates that capability's tables on the next boot against the same storage", async () => {
    const storage = createTestStorage();

    const firstBase = server({
      capabilities: [channels()],
    });
    const firstRoom = firstBase.channel('room', {
      capabilities: [emits({ said: t<{ text: string }>() })],
    });
    const firstDefinition = firstBase.assemble({ handlers: [firstRoom] });
    const firstEngine = buildEngine(firstDefinition);
    firstEngine.core.storage = storage as never;

    await firstEngine.initialize();

    const secondBase = server({
      capabilities: [
        channels(),
        tags((_ephemeral, persistent) => [persistent('favorite', t<string>())]),
      ],
    });
    const secondRoom = secondBase.channel('room', {
      capabilities: [emits({ said: t<{ text: string }>() })],
    });
    const secondDefinition = secondBase.assemble({ handlers: [secondRoom] });
    const secondEngine = buildEngine(secondDefinition);
    secondEngine.core.storage = storage as never;

    await secondEngine.initialize();

    insertTag(storage.sql, { userId: 'alice', group: 'favorite', key: 'blue' });

    const connection = fakeConnection('c-1', 'alice');
    secondEngine.core.connections.set(connection.id, connection);

    await expect(secondEngine.admin().purgeUser('alice')).resolves.toBeUndefined();
  });
});
