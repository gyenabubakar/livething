/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Boot round-trip budget. Counts the number of `sql.exec` calls
 * `engine.initialize()` issues for tiny/medium/heavy contracts, on cold
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
import { defineServerAdapter } from '~/_adapters/define.ts';
import { contract } from '~/_api/contract.ts';
import { t } from '~/_api/definitions.ts';
import { implement } from '~/_api/implement.ts';
import { scope } from '~/channel/channel.ts';
import { channel } from '~/channel/definition.ts';
import { incoming } from '~/incoming/definition.ts';
import { namespace } from '~/namespace/definition.ts';
import { outgoing } from '~/outgoing/definition.ts';
import { request } from '~/request/definition.ts';
import { recordedStream } from '~/stream-recorded/definition.ts';
import { resumableStream } from '~/stream-resumable/definition.ts';
import { stream } from '~/stream/definition.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

// ── Fake SQL provider ──────────────────────────────────────────────────────
//
// Records every `exec` call and simulates the `__wskit_meta` sentinel for
// warm-boot tests.
function makeFakeStorage(opts?: { warmedSchemaVersion?: string }) {
  const calls: string[] = [];
  let schemaVersion: string | null = opts?.warmedSchemaVersion ?? null;

  const sql = {
    exec(query: string, ...params: unknown[]) {
      calls.push(query);
      const trimmed = query.trim();

      // Simulate the meta-table SELECT for the sentinel check.
      if (trimmed.startsWith('SELECT') && trimmed.includes('__wskit_meta')) {
        if (schemaVersion === null) {
          // Table doesn't exist on a fresh DO — same shape as Cloudflare.
          throw new Error('no such table: __wskit_meta');
        }
        return {
          toArray: () => [{ value: schemaVersion }],
          one: () => ({ value: schemaVersion }),
          raw: () => [[schemaVersion]],
        };
      }

      // Mark schema initialized — the engine's bundled CREATE + INSERT.
      if (trimmed.includes('__wskit_meta') && trimmed.includes('INSERT')) {
        schemaVersion = (params[0] as string) ?? null;
      }

      return {
        toArray: () => [],
        one: () => null,
        raw: () => [],
      };
    },
    transaction<T>(fn: (tx: any) => T): T {
      return fn(sql);
    },
  };

  const storage = {
    sql,
    kv: {
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {},
      async list() {
        return [];
      },
    },
  };

  return { storage, calls, sql };
}

function makeNoopTimers() {
  return {
    setAlarm() {},
    deleteAlarm() {},
    getAlarm() {
      return null;
    },
  };
}

// Build an Engine via the same path the CF adapter uses, but capture the
// instance instead of returning a DO class.
function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const serve = defineServerAdapter({
    id: 'roundtrip-bench',
    hibernation: { persist() {}, restore: () => undefined },
    setup(createEngine) {
      captured = createEngine({
        storage: undefined,
        env: {},
        platform: {},
        timers: makeNoopTimers() as never,
        asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
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
  serve(handler, undefined as never);
  if (!captured) throw new Error('engine not captured');
  return captured;
}

async function initWithFakeStorage(handler: ServerDefinition, warm = false) {
  const { storage, calls } = makeFakeStorage(warm ? { warmedSchemaVersion: '1' } : {});
  const engine = buildEngine(handler);
  engine.core.storage = storage as never;
  await engine.initialize();
  return { execCount: calls.length, calls };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const Empty = v.object({});
const Text = v.object({ text: v.string() });
const NumChunk = v.object({ n: v.number() });

const tinyHandler = implement(
  contract('rt-tiny', {
    env: t<Record<string, unknown>>(),
    definitions: [incoming('noop', Empty), outgoing('ack', Empty)],
  }),
)
  .on('noop', () => {})
  .build();

const mediumHandler = implement(
  contract('rt-medium', {
    env: t<Record<string, unknown>>(),
    persistence: true,
    hibernation: true,
    definitions: [
      incoming('join', Empty),
      incoming('leave', Empty),
      incoming('noop', Empty),
      outgoing('ack', Empty),
      outgoing('joined', Empty),
      request('whoami', { payload: Empty, response: v.object({ id: v.string() }) }),
      stream('tail', { payload: Empty, chunk: NumChunk }),
      channel('lobby', { definitions: [incoming('say', Text), outgoing('said', Text)] }),
      channel(scope('rooms', /^room:.+$/), {
        definitions: [incoming('post', Text), outgoing('posted', Text)],
      }),
      namespace('admin', {
        definitions: [
          incoming('kick', v.object({ id: v.string() })),
          outgoing('kicked', v.object({ id: v.string() })),
        ],
      }),
    ],
  }),
)
  .on('noop', () => {})
  .on('join', () => {})
  .on('leave', () => {})
  .request('whoami', (ctx) => {
    ctx.respond({ id: ctx.identity });
  })
  .stream('tail', async function* () {
    yield { n: 1 };
  })
  .channel('lobby', (ch) => ch.on('say', () => {}))
  .channel('rooms', (ch) => ch.on('post', () => {}))
  .namespace('admin', (ns) => ns.on('kick', () => {}))
  .build();

function channelDefs(prefix: string) {
  return [
    incoming(`${prefix}-send`, Text),
    incoming(`${prefix}-edit`, Text),
    outgoing(`${prefix}-message`, Text),
    outgoing(`${prefix}-edited`, Text),
  ] as const;
}

const heavyContract = contract('rt-heavy', {
  env: t<Record<string, unknown>>(),
  persistence: true,
  hibernation: true,
  replay: true,
  sequence: { persist: true },
  definitions: [
    incoming('a', Empty),
    incoming('b', Empty),
    incoming('c', Empty),
    incoming('d', Empty),
    incoming('e', Empty),
    outgoing('o-a', Empty),
    outgoing('o-b', Empty),
    outgoing('o-c', Empty),
    outgoing('o-d', Empty),
    outgoing('o-e', Empty),
    request('r-a', { payload: Empty, response: Empty }),
    request('r-b', { payload: Empty, response: Empty }),
    request('r-c', { payload: Empty, response: Empty }),
    stream('s-a', { payload: Empty, chunk: NumChunk }),
    stream('s-b', { payload: Empty, chunk: NumChunk }),
    resumableStream('rs-a', { payload: Empty, chunk: NumChunk }),
    recordedStream('rec-a', { payload: Empty, chunk: NumChunk }),
    channel('chan-1', { definitions: channelDefs('c1') }),
    channel('chan-2', { definitions: channelDefs('c2') }),
    channel('chan-3', { definitions: channelDefs('c3') }),
    channel('chan-4', { definitions: channelDefs('c4') }),
    channel('chan-5', { definitions: channelDefs('c5') }),
    channel(scope('rooms-1', /^r1:.+$/), { definitions: channelDefs('r1') }),
    channel(scope('rooms-2', /^r2:.+$/), { definitions: channelDefs('r2') }),
    channel(scope('rooms-3', /^r3:.+$/), { definitions: channelDefs('r3') }),
    channel(scope('rooms-4', /^r4:.+$/), { definitions: channelDefs('r4') }),
    channel(scope('rooms-5', /^r5:.+$/), { definitions: channelDefs('r5') }),
    namespace('admin', {
      definitions: [
        incoming('kick', v.object({ id: v.string() })),
        incoming('ban', v.object({ id: v.string() })),
        outgoing('kicked', v.object({ id: v.string() })),
      ],
    }),
    namespace('v1', {
      definitions: [
        incoming('noop', Empty),
        outgoing('ack', Empty),
        request('echo', { payload: Empty, response: Empty }),
      ],
    }),
  ],
});

const heavyImpl: any = implement(heavyContract as any);
for (const def of heavyContract.definitions as readonly any[]) {
  if (def._ === 'incoming') heavyImpl.on(def.name, () => {});
  if (def._ === 'request') heavyImpl.request(def.name, (ctx: any) => ctx.respond({}));
  if (def._ === 'stream')
    heavyImpl.stream(def.name, async function* () {
      yield { n: 1 };
    });
  if (def._ === 'resumable-stream')
    heavyImpl.resumableStream(def.name, async function* () {
      yield { n: 1 };
    });
  if (def._ === 'recorded-stream')
    heavyImpl.recordedStream(def.name, async function* () {
      yield { n: 1 };
    });
  if (def._ === 'channel') {
    const key = typeof def.pattern === 'string' ? def.pattern : def.pattern.key;
    heavyImpl.channel(key, (ch: any) => {
      for (const child of def.definitions as readonly any[]) {
        if (child._ === 'incoming') ch.on(child.name, () => {});
      }
      return ch;
    });
  }
  if (def._ === 'namespace') {
    heavyImpl.namespace(def.name, (ns: any) => {
      for (const child of def.definitions as readonly any[]) {
        if (child._ === 'incoming') ns.on(child.name, () => {});
        if (child._ === 'request') ns.request(child.name, (ctx: any) => ctx.respond({}));
      }
      return ns;
    });
  }
}
const heavyHandler = heavyImpl.build();

// ── Tests ──────────────────────────────────────────────────────────────────

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
    expect(execCount).toBe(11);
  });

  it('heavy: WARM boot (sentinel current) skips every schema hook', async () => {
    const { execCount, calls } = await initWithFakeStorage(heavyHandler, true);
    if (execCount !== 5) {
      // eslint-disable-next-line no-console
      console.log(
        '[heavy warm] sql.exec calls:\n' +
          calls.map((q, i) => `  ${i + 1}. ${q.trim().slice(0, 80)}`).join('\n'),
      );
    }
    // Compared to cold (11): saves 5 schema hooks + 1 mark = 6 round trips
    // skipped. Remaining: 1 sentinel SELECT + 4 cleanup/state-restore.
    expect(execCount).toBe(5);
  });
});
