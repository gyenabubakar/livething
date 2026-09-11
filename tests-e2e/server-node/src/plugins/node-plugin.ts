import { define, emits, error, errors, t } from '@wskit/server';
import { intercepts } from '@wskit/server/intercepts';
import { plugin } from '@wskit/server/plugins';
import { scheduled } from '@wskit/server/scheduled';
import * as v from 'valibot';
import type { Platform } from '@wskit/server-node';
import type { SQLProvider } from '@wskit/server/adapters';

interface LastConnectionState {
  id: string;
  username: string | null;
  tags: { group: string; key: string }[];
}

interface NodePluginState {
  lastGeneratedId: string | null;
  lastState: LastConnectionState | null;
  messageCount: number;
  outgoingCount: number;
  disconnectCount: number;
  everyTickCount: number;
  flakyAttempts: number;
}

const denied = error('denied', v.object({ reason: v.string(), op: v.string() }));
const taskDataSchema = v.object({ value: v.string() });
const REWRITE_PROBE = 'plugin-rewrite-probe';
const stateByPlatform = new WeakMap<Platform, NodePluginState>();

function getState(platform: Platform): NodePluginState {
  let state = stateByPlatform.get(platform);
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
    stateByPlatform.set(platform, state);
  }

  return state;
}

const h = define({
  scope: 'plugin',
  capabilities: [
    emits({
      'drizzle-ready': t<{ tables: string[] }>(),
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
  ctx.sql.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  ctx.sql.exec(`
    CREATE TABLE IF NOT EXISTS plugin_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `);
  ctx.sql.exec("INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('shutdown_count', 0)");
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

  ctx.send('drizzle-ready', { tables: ['records'] });
});

h.onDisconnect((ctx) => {
  getState(ctx.platform as Platform).disconnectCount++;
});

h.onShutdown((ctx) => {
  ctx.sql.exec(
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

h.scheduled('drizzle-vacuum', {
  run(ctx) {
    ctx.broadcast('drizzle-vacuum-done', { timestamp: Date.now() });
  },
});

h.scheduled('drizzle-every-tick', {
  run(ctx) {
    const state = getState(ctx.platform as Platform);
    state.everyTickCount++;
    ctx.broadcast('plugin-every-tick', { count: state.everyTickCount });
  },
});

h.scheduled('drizzle-flaky', {
  run(ctx) {
    const state = getState(ctx.platform as Platform);
    state.flakyAttempts++;
    if (state.flakyAttempts < 3) throw new Error('module flaky failure');

    ctx.broadcast('plugin-flaky-result', { attempts: state.flakyAttempts });
    state.flakyAttempts = 0;
  },
});

h.scheduled('drizzle-module-always-fail', {
  run() {
    throw new Error('module permanent failure');
  },
});

h.scheduled('drizzle-query-dlq', {
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

h.scheduled('drizzle-task-with-data', {
  run(ctx, data) {
    ctx.broadcast('plugin-task-data-result', {
      result: `validated-data-received:${data.value}`,
    });
  },
});

function readRecord(ctx: { sql: SQLProvider }, id: number) {
  return ctx.sql
    .exec<{
      id: number;
      name: string;
      value: string;
      createdAt: number;
    }>('SELECT id, name, value, created_at AS createdAt FROM records WHERE id = ?', id)
    .one();
}

export const NodePlugin = plugin('e2e:drizzle', {
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
    ],
    api: (ctx) => {
      const state = getState(ctx.platform as Platform);
      return {
        insert(data: { name: string; value: string }) {
          ctx.sql.exec(
            'INSERT INTO records (name, value, created_at) VALUES (?, ?, ?)',
            data.name,
            data.value,
            Date.now(),
          );
          return readRecord(
            ctx,
            Number(ctx.sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').one()?.id),
          );
        },
        findAll() {
          return ctx.sql
            .exec<{
              id: number;
              name: string;
              value: string;
              createdAt: number;
            }>('SELECT id, name, value, created_at AS createdAt FROM records ORDER BY id')
            .toArray();
        },
        findById(id: number) {
          return readRecord(ctx, id);
        },
        deleteById(id: number) {
          const before = readRecord(ctx, id);
          ctx.sql.exec('DELETE FROM records WHERE id = ?', id);
          return before !== null;
        },
        count() {
          return Number(
            ctx.sql.exec<{ value: number }>('SELECT COUNT(*) AS value FROM records').one()?.value ??
              0,
          );
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
          return Number(
            ctx.sql
              .exec<{ value: number }>("SELECT value FROM plugin_meta WHERE key = 'shutdown_count'")
              .one()?.value ?? 0,
          );
        },
        getCurrentConnectionId() {
          return ctx.connection.id ?? null;
        },
      };
    },
  }),
});
