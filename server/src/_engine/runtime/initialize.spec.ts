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
 * The schema-version sentinel (option B) means warm boots skip every
 * `bootSchema` hook and only run the sentinel SELECT.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { InternalError } from '@wskit/core';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { persistence } from '~/persistence/capability.ts';
import { replay } from '~/replay/capability.ts';
import { requests } from '~/request/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function makeFakeStorage(opts?: { warmedSchemaVersion?: string }) {
  const calls: string[] = [];
  const storage = createTestStorage({ onExec: (query) => calls.push(query) });

  if (opts?.warmedSchemaVersion !== undefined) {
    // Seed the real schema-meta row directly, as if a previous boot already
    // wrote it — this does not count against the round-trip budget below.
    storage.sql.exec(
      `
        CREATE TABLE IF NOT EXISTS __wskit_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT OR REPLACE INTO __wskit_meta (key, value) VALUES ('schema_version', ?)
      `,
      opts.warmedSchemaVersion,
    );
    calls.length = 0;
  }

  return { storage, calls };
}

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'roundtrip-bench',
    hibernation: { persist() {}, restore: () => undefined },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        env: {},
        platform: {},
        timers: createTestTimers(),
        waitUntil: () => {},
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      });
      return {};
    },
  });
  server(handler, undefined as never);
  if (!captured) throw new Error('engine not captured');
  return captured;
}

async function initWithFakeStorage(handler: ServerDefinition, warm = false) {
  const { storage, calls } = makeFakeStorage();

  if (warm) {
    // Run a full cold boot first so every schema table and the meta row
    // exist, exactly as a previous boot would have left them. A second,
    // separate engine instance then wakes against the same storage — the
    // real shape of a warm boot after a restart.
    const warmup = buildEngine(handler);
    warmup.core.storage = storage as never;
    await warmup.initialize();
    calls.length = 0;
  }

  const engine = buildEngine(handler);
  engine.core.storage = storage as never;
  await engine.initialize();
  return { execCount: calls.length, calls };
}

const Empty = v.object({});
const Text = v.object({ text: v.string() });
const NumChunk = t<{ n: number }>();

const EmptyOut = t<Record<string, never>>();
const TextOut = t<{ text: string }>();

const tinyBase = define({
  env: t<Record<string, unknown>>(),
  capabilities: [emits({ notify: EmptyOut })],
});
const tinyHandler = tinyBase.assemble({
  handlers: [tinyBase.on('noop', { input: Empty, run() {} })],
});

const mediumBase = define({
  env: t<Record<string, unknown>>(),
  hibernation: { enabled: true },
  capabilities: [
    persistence(),
    requests(),
    stream(),
    channels(),
    emits({ notify: EmptyOut, joined: EmptyOut }),
  ],
});
const mediumLobby = mediumBase.channel('lobby', { outgoing: { emits: { said: TextOut } } });
mediumLobby.on('say', { input: Text, run() {} });
const mediumRooms = mediumBase.channel(['rooms', 'room:{id}'], {
  outgoing: { emits: { posted: TextOut } },
});
mediumRooms.on('post', { input: Text, run() {} });
const mediumHandler = mediumBase.assemble({
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

const heavyBase = define({
  env: t<Record<string, unknown>>(),
  hibernation: { enabled: true },
  capabilities: [
    persistence(),
    dedup(),
    sequence({ persist: true }),
    replay.history(),
    requests(),
    stream(),
    resumableStream(),
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
  heavyBase.resumableStream('rs-a', {
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
  const ch = heavyBase.channel(`chan-${n}`, { outgoing: { emits: channelEmits(`c${n}`) } });
  ch.on(`c${n}-send`, { input: Text, run() {} });
  ch.on(`c${n}-edit`, { input: Text, run() {} });
  heavyHandlers.push(ch);
}
for (const n of [1, 2, 3, 4, 5]) {
  const ch = heavyBase.channel([`rooms-${n}`, `r${n}:{id}`], {
    outgoing: { emits: channelEmits(`r${n}`) },
  });
  ch.on(`r${n}-send`, { input: Text, run() {} });
  ch.on(`r${n}-edit`, { input: Text, run() {} });
  heavyHandlers.push(ch);
}
const heavyHandler = heavyBase.assemble({ handlers: [...heavyHandlers] });

describe('engine.initialize — sql.exec round-trip budget', () => {
  it('tiny (no schema features): cold boot issues 0 exec calls', async () => {
    const { execCount } = await initWithFakeStorage(tinyHandler);
    expect(execCount).toBe(0);
  });

  it('medium (persistence + hibernation): cold boot exec budget', async () => {
    const { execCount, calls } = await initWithFakeStorage(mediumHandler);
    if (execCount !== 5) {
      // eslint-disable-next-line no-console
      console.log(
        '[medium cold] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }
    // 1 sentinel SELECT + 2 schema hooks (persistence, hibernation) + 1 mark
    // + 1 cleanup (persistence reconcile SELECT). No replay/sequence/scheduled.
    expect(execCount).toBe(5);
  });

  it('medium: WARM boot saves schema round trips', async () => {
    const { execCount, calls } = await initWithFakeStorage(mediumHandler, true);
    if (execCount !== 2) {
      // eslint-disable-next-line no-console
      console.log(
        '[medium warm] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }
    // 1 sentinel SELECT (returns row) + 1 cleanup (persistence reconcile).
    expect(execCount).toBe(2);
  });

  it('heavy (persistence + hibernation + replay + sequence + scheduled): cold boot exec budget', async () => {
    const { execCount, calls } = await initWithFakeStorage(heavyHandler);
    if (execCount !== 11) {
      // eslint-disable-next-line no-console
      console.log(
        '[heavy cold] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }
    // Breakdown:
    //   1. sentinel SELECT (throws — no table yet)
    //   2-6. five schema hooks: persistence, connections (hibernation),
    //        sequence, replay, scheduled
    //   7. mark sentinel (bundled CREATE meta + INSERT)
    //   8. persistence reconcile (cleanup SELECT)
    //   9-10. scheduled bootstrap loads queued runs + dlq
    //   11. scheduled persist-after-restore — one INSERT for the new recurring
    //       run added by ensureRecurringRuns. The diff-based persist no longer
    //       emits DELETE-all / reinsert-all per call, so the empty-load case
    //       costs zero extra writes; only genuine new rows are written.
    //
    // The resumableStream()/recordedStream() capabilities install an internal
    // recurring '__wskit:stream-durable-sweep' task whenever a server declares a
    // durable stream. That task boots the scheduled engine, which adds the schema
    // hook (#5), the bootstrap loads (#9-10), and the one persist-after-restore
    // INSERT (#11) — so a durable-stream server pays 11 round trips on a cold boot.
    expect(execCount).toBe(11);
  });

  it('heavy: WARM boot (sentinel current) skips every schema hook', async () => {
    const { execCount, calls } = await initWithFakeStorage(heavyHandler, true);
    if (execCount !== 4) {
      // eslint-disable-next-line no-console
      console.log(
        '[heavy warm] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }
    // Breakdown:
    //   1. sentinel SELECT (returns row)
    //   2. persistence reconcile (cleanup SELECT)
    //   3-4. scheduled bootstrap loads queued runs + dlq
    //
    // The recurring '__wskit:stream-durable-sweep' task (installed whenever a
    // server declares a durable stream) was already persisted during the cold
    // boot that seeded this storage, so the warm boot's bootstrap finds it in
    // the loaded rows and issues no extra persist write.
    expect(execCount).toBe(4);
  });
});

describe('engine.initialize — freshBoot only on a truly empty DB', () => {
  async function initAndGetEngine(opts?: { warmedSchemaVersion?: string }) {
    const { storage } = makeFakeStorage(opts);
    const engine = buildEngine(mediumHandler);
    engine.core.storage = storage as never;
    await engine.initialize();
    return engine;
  }

  it('sets freshBoot on a cold boot with no prior schema', async () => {
    const engine = await initAndGetEngine();
    expect(engine.core.freshBoot).toBe(true);
  });

  it('does NOT set freshBoot on a migration (older schema version present)', async () => {
    const engine = await initAndGetEngine({ warmedSchemaVersion: '0' });
    expect(engine.core.freshBoot).toBe(false);
  });
});

describe('engine declaredErrorCodes', () => {
  it('includes the internal-error fallback code', () => {
    const engine = buildEngine(tinyHandler);
    expect(engine.core.declaredErrorCodes.has(InternalError.code)).toBe(true);
  });
});

describe('revalidate requires a persistent channel', () => {
  const channelOutgoing = { outgoing: { emits: { said: TextOut } } };

  it('throws at boot when a non-persistent channel has a .revalidate() hook', async () => {
    const base = define({ env: t<Record<string, unknown>>(), capabilities: [channels()] });
    const room = base.channel('room', { ...channelOutgoing, revalidate() {} });
    const handler = base.assemble({ handlers: [room] });

    await expect(initWithFakeStorage(handler)).rejects.toThrow(
      /Channel "room" has a \.revalidate\(\) hook but is not persistent/,
    );
  });

  it('throws when a `persistent: false` channel has a .revalidate() hook', async () => {
    const base = define({
      env: t<Record<string, unknown>>(),
      capabilities: [persistence(), channels()],
    });
    const room = base.channel('room', { ...channelOutgoing, persistent: false, revalidate() {} });
    const handler = base.assemble({ handlers: [room] });

    await expect(initWithFakeStorage(handler)).rejects.toThrow(/is not persistent/);
  });

  it('boots fine when a persistent channel has a .revalidate() hook', async () => {
    const base = define({
      env: t<Record<string, unknown>>(),
      capabilities: [persistence(), channels()],
    });
    const room = base.channel('room', { ...channelOutgoing, revalidate() {} });
    const handler = base.assemble({ handlers: [room] });

    await expect(initWithFakeStorage(handler)).resolves.toBeDefined();
  });
});
