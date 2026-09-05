import { define, emits, error, errors, t } from '@wskit/server';
import { intercepts } from '@wskit/server/intercepts';
import { plugin } from '@wskit/server/plugins';
import { scheduled } from '@wskit/server/scheduled';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as v from 'valibot';
import type { Platform } from '@wskit/server-cloudflare';
import type { PluginsEnv } from '@wskit/tests-e2e-handlers/plugins';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import * as schema from './schema.ts';
import { pluginMeta, records } from './schema.ts';
import type { InsertRecord } from './schema.ts';

interface LastConnectionState {
  id: string;
  username: string | null;
  tags: { group: string; key: string }[];
}

const denied = error('denied', v.object({ reason: v.string(), op: v.string() }));

const taskDataSchema = v.object({ value: v.string() });

const REWRITE_PROBE = 'plugin-rewrite-probe';

// A drizzle handle is bound to one Durable Object's storage and cannot be used
// from another DO's execution context. The plugin handler is module-scoped, so
// keep one handle per DO keyed by its storage object (stable per instance) and
// build it lazily.
const dbByStorage = new WeakMap<DurableObjectStorage, DrizzleSqliteDODatabase<typeof schema>>();

function getDb(platform: Platform): DrizzleSqliteDODatabase<typeof schema> {
  const { storage } = platform.ctx;
  let db = dbByStorage.get(storage);
  if (!db) {
    db = drizzle(storage, { schema });
    dbByStorage.set(storage, db);
  }
  return db;
}

// Last-connection fields and the hook counters are also kept per DO: the tests
// pair the id observed at connect with the same connection's later reads, and a
// module-level counter would be shared across every DO on the isolate (state
// bleed under parallel load). This in-memory-per-DO map is fine for
// within-session counts; for durable counts use the DO's SQL the way
// shutdown_count does.
interface DoState {
  lastGeneratedId: string | null;
  lastState: LastConnectionState | null;
  messageCount: number;
  outgoingCount: number;
  disconnectCount: number;
  everyTickCount: number;
  flakyAttempts: number;
}
const stateByStorage = new WeakMap<DurableObjectStorage, DoState>();

function getState(platform: Platform): DoState {
  const { storage } = platform.ctx;
  let state = stateByStorage.get(storage);
  if (!state) {
    state = {
      lastGeneratedId: null,
      lastState: null,
      messageCount: 0,
      outgoingCount: 0,
      disconnectCount: 0,
      everyTickCount: 0,
      flakyAttempts: 0,
    };
    stateByStorage.set(storage, state);
  }
  return state;
}

const h = define({
  scope: 'plugin',
  env: t<PluginsEnv>(),
  capabilities: [
    emits({
      'drizzle-ready': t<{ tables: string[] }>(),
      'plugin-env-result': t<{ label: string }>(),
      'drizzle-vacuum-done': t<{ timestamp: number }>(),
      'plugin-every-tick': t<{ count: number }>(),
      'plugin-flaky-result': t<{ attempts: number }>(),
      'plugin-dlq-result': t<{
        taskId: string;
        attempts: number;
        error: string;
      }>(),
      'plugin-task-data-result': t<{ result: string }>(),
      'error-result': t<{ code: string; message: string }>(),
    }),
    errors([denied]),
    scheduled({
      'drizzle-vacuum': null,
      'drizzle-every-tick': { every: 500 },
      'drizzle-flaky': { retry: [50, 100, 200] },
      'drizzle-module-always-fail': { retry: [50, 100] },
      'drizzle-query-dlq': null,
      'drizzle-task-with-data': { data: taskDataSchema },
    }),
    intercepts(),
  ],
});

h.onInit((ctx) => {
  const db = getDb(ctx.platform as Platform);

  db.run(
    `CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS plugin_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`,
  );
  db.run(`INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('shutdown_count', 0)`);
});

h.onConnect((ctx) => {
  const state = getState(ctx.platform as Platform);
  state.lastGeneratedId = `drizzle-${ctx.connection.id}`;
  const self = ctx.connections.all().find((c) => c.id === ctx.connection.id);
  const meta = ctx.meta as { username?: unknown };
  state.lastState = {
    id: ctx.connection.id,
    username: typeof meta.username === 'string' ? meta.username : null,
    tags: (self?.tags ?? []).map((tag) => ({ group: tag.group, key: tag.key })),
  };
  ctx.send('plugin-env-result', { label: ctx.env.PLUGIN_LABEL });
  ctx.send('drizzle-ready', { tables: ['records'] });
});

h.onDisconnect((ctx) => {
  getState(ctx.platform as Platform).disconnectCount++;
});

h.onShutdown((ctx) => {
  getDb(ctx.platform as Platform).run(
    "INSERT INTO plugin_meta (key, value) VALUES ('shutdown_count', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1",
  );
});

h.intercept((ctx, frame) => {
  getState(ctx.platform as Platform).messageCount++;
  if (
    frame.owner.kind === 'app' &&
    frame.event === REWRITE_PROBE &&
    frame.payload &&
    typeof frame.payload === 'object'
  ) {
    const payload = frame.payload as { text: string };
    return { ...payload, text: `rewritten:${payload.text}`, rewritten: true };
  }
});

h.onOutgoing((ctx, frame) => {
  // The outgoing-hook ctx is resolved per send: it is the sending connection's
  // ctx for a direct ctx.send, but undefined for a broadcast (no one connection
  // owns it). Only the connection-scoped sends carry a platform, so only those
  // can reach this DO's state — guard before touching it.
  if (ctx) getState(ctx.platform as Platform).outgoingCount++;
  if (
    frame.owner.kind === 'plugin' &&
    frame.event === 'drizzle-ready' &&
    frame.payload &&
    typeof frame.payload === 'object'
  ) {
    return { ...(frame.payload as Record<string, unknown>), hooked: true };
  }
});

const triggerDenied = h.on('trigger-plugin-denied', {
  input: v.object({}),
  run() {
    throw denied({ reason: 'test denial', op: 'insert' });
  },
});

const triggerError = h.on('trigger-plugin-error', {
  input: v.object({}),
  run(ctx) {
    try {
      throw denied({ reason: 'test denial', op: 'insert' });
    } catch (err: unknown) {
      const e = err as { code: string; detail?: { reason: string } };
      ctx.send('error-result', { code: e.code, message: e.detail?.reason ?? 'unknown' });
    }
  },
});

const triggerVacuum = h.on('trigger-vacuum', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('drizzle-vacuum', { time: Date.now() + 200 });
  },
});

const triggerEvery = h.on('trigger-plugin-every', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('drizzle-every-tick', { time: Date.now() + 100 });
  },
});

const triggerFlaky = h.on('trigger-plugin-flaky', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('drizzle-flaky', { time: Date.now() + 100 });
  },
});

const triggerAlwaysFail = h.on('trigger-plugin-always-fail', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('drizzle-module-always-fail', { time: Date.now() + 100 });
  },
});

const triggerQueryDlq = h.on('trigger-plugin-query-dlq', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('drizzle-query-dlq', { time: Date.now() + 100 });
  },
});

const triggerTaskWithData = h.on('trigger-plugin-task-with-data', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('drizzle-task-with-data', {
      time: Date.now() + 100,
      data: { value: 'test-data' },
    });
  },
});

const vacuum = h.scheduled('drizzle-vacuum', {
  run(ctx) {
    ctx.broadcast('drizzle-vacuum-done', { timestamp: Date.now() });
  },
});

const everyTick = h.scheduled('drizzle-every-tick', {
  run(ctx) {
    const state = getState(ctx.platform as Platform);
    state.everyTickCount++;
    ctx.broadcast('plugin-every-tick', { count: state.everyTickCount });
  },
});

const flaky = h.scheduled('drizzle-flaky', {
  run(ctx) {
    const state = getState(ctx.platform as Platform);
    state.flakyAttempts++;
    if (state.flakyAttempts < 3) throw new Error('module flaky failure');
    ctx.broadcast('plugin-flaky-result', { attempts: state.flakyAttempts });
    state.flakyAttempts = 0;
  },
});

const alwaysFail = h.scheduled('drizzle-module-always-fail', {
  run() {
    throw new Error('module permanent failure');
  },
});

const queryDlq = h.scheduled('drizzle-query-dlq', {
  run(ctx) {
    const rows = ctx.sql
      .exec<{
        taskId: string;
        attempts: number;
        error: string;
      }>('SELECT taskId, attempts, error FROM __wskit_scheduled_dlq ORDER BY failedAt DESC LIMIT 1')
      .toArray();
    const row = rows[0];
    if (row) {
      const err = JSON.parse(row.error) as { message: string };
      ctx.broadcast('plugin-dlq-result', {
        taskId: row.taskId,
        attempts: row.attempts,
        error: err.message,
      });
    }
  },
});

const taskWithData = h.scheduled('drizzle-task-with-data', {
  run(ctx, data) {
    ctx.broadcast('plugin-task-data-result', {
      result: `validated-data-received:${data.value}`,
    });
  },
});

export const Drizzle = plugin('e2e:drizzle', {
  handler: h.assemble({
    handlers: [
      triggerDenied,
      triggerError,
      triggerVacuum,
      triggerEvery,
      triggerFlaky,
      triggerAlwaysFail,
      triggerQueryDlq,
      triggerTaskWithData,
      vacuum,
      everyTick,
      flaky,
      alwaysFail,
      queryDlq,
      taskWithData,
    ],
    api: (ctx) => {
      const db = getDb(ctx.platform as Platform);
      const state = getState(ctx.platform as Platform);
      return {
        insert(data: Omit<InsertRecord, 'id' | 'createdAt'>) {
          const [row] = db.insert(records).values(data).returning().all();
          return row!;
        },
        findAll() {
          return db.select().from(records).orderBy(records.id).all();
        },
        findById(id: number) {
          return db.select().from(records).where(eq(records.id, id)).get();
        },
        deleteById(id: number) {
          const deleted = db.delete(records).where(eq(records.id, id)).returning().all();
          return deleted.length > 0;
        },
        count() {
          const [row] = db.select({ value: count() }).from(records).all();
          return row?.value ?? 0;
        },
        getMessageCount() {
          return state.messageCount;
        },
        getOutgoingCount() {
          return state.outgoingCount;
        },
        getDisconnectCount() {
          return state.disconnectCount;
        },
        getLastGeneratedId() {
          return state.lastGeneratedId;
        },
        getLastState() {
          return state.lastState;
        },
        getShutdownCount() {
          return (
            db.select().from(pluginMeta).where(eq(pluginMeta.key, 'shutdown_count')).get()?.value ??
            0
          );
        },
        getCurrentConnectionId() {
          return ctx.connection.id ?? null;
        },
      };
    },
  }),
});
