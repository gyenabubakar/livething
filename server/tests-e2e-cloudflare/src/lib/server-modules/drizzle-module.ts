import { defineModule } from '@wskit/server';
import { error, errors } from '@wskit/server/errors';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as v from 'valibot';
import type { Platform } from '@wskit/server-cloudflare';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import * as schema from './schema.ts';
import { moduleMeta, records } from './schema.ts';
import type { InsertRecord } from './schema.ts';

const DRIZZLE_KEY = Symbol('e2e:drizzle');

export const DrizzleDenied = error(
  'e2e-drizzle/denied',
  v.object({ reason: v.string(), op: v.string() }),
);

interface LastConnectionState {
  id: string;
  username: string | null;
  tags: string[];
}

export interface DrizzleApi {
  insert(data: Omit<InsertRecord, 'id' | 'createdAt'>): schema.Record;
  findAll(): schema.Record[];
  findById(id: number): schema.Record | undefined;
  deleteById(id: number): boolean;
  count(): number;
  getMessageCount(): number;
  getOutgoingCount(): number;
  getDisconnectCount(): number;
  getLastGeneratedId(): string | null;
  getLastState(): LastConnectionState | null;
  getShutdownCount(): number;
}

export const Drizzle = defineModule({
  id: 'e2e:drizzle',
  key: DRIZZLE_KEY,
  requires: { storage: true },
  outgoing: {
    'drizzle-ready': v.object({ tables: v.array(v.string()) }),
  },
  errors: errors(DrizzleDenied),

  setup(args: { migrate: boolean }, hooks): () => DrizzleApi {
    let db: DrizzleSqliteDODatabase<typeof schema>;
    let messageCount = 0;
    let outgoingCount = 0;
    let disconnectCount = 0;
    let lastGeneratedId: string | null = null;
    let lastState: LastConnectionState | null = null;

    hooks.onInit((ctx) => {
      db = drizzle((ctx.platform as Platform).ctx.storage, { schema });

      if (args.migrate) {
        db.run(
          `CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )`,
        );
      }

      db.run(
        `CREATE TABLE IF NOT EXISTS module_meta (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        )`,
      );
      db.run(`INSERT OR IGNORE INTO module_meta (key, value) VALUES ('shutdown_count', 0)`);
    });

    hooks.onConnect((ctx) => {
      const state = hooks.getState();
      lastGeneratedId = hooks.generateId('drizzle');
      lastState = {
        id: state.id,
        username:
          state.meta && typeof state.meta.username === 'string' ? state.meta.username : null,
        tags: [...state.tags],
      };
      ctx.send('drizzle-ready', { tables: ['records'] });
    });

    hooks.onDisconnect((_ctx) => {
      disconnectCount++;
    });

    hooks.onShutdown(() => {
      db.run(
        "INSERT INTO module_meta (key, value) VALUES ('shutdown_count', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1",
      );
      console.log('[drizzle-module] shutdown, processed', messageCount, 'messages');
    });

    hooks.onIncoming((message) => {
      messageCount++;
      if (
        message.event === 'module-rewrite-probe' &&
        message.payload &&
        typeof message.payload === 'object'
      ) {
        return {
          event: message.event,
          payload: {
            ...(message.payload as Record<string, unknown>),
            text: `rewritten:${(message.payload as { text: string }).text}`,
            rewritten: true,
          },
        };
      }
      return message;
    });

    hooks.onOutgoing((message) => {
      outgoingCount++;
      if (
        message.event === '__e2e:drizzle:drizzle-ready' &&
        message.payload &&
        typeof message.payload === 'object'
      ) {
        return {
          ...message,
          payload: {
            ...message.payload,
            hooked: true,
          },
        };
      }
      return message;
    });

    hooks.scheduled('drizzle-vacuum', async (ctx) => {
      ctx.broadcast('drizzle-vacuum-done', { timestamp: Date.now() });
    });

    let everyTickCount = 0;
    hooks.scheduled(
      'drizzle-every-tick',
      async (ctx) => {
        everyTickCount++;
        ctx.broadcast('module-every-tick', { count: everyTickCount });
      },
      { every: 500 },
    );

    let flakyAttempts = 0;
    hooks.scheduled(
      'drizzle-flaky',
      async (ctx) => {
        flakyAttempts++;
        if (flakyAttempts < 3) throw new Error('module flaky failure');
        ctx.broadcast('module-flaky-result', { attempts: flakyAttempts });
        flakyAttempts = 0;
      },
      { retry: [50, 100, 200] },
    );

    hooks.scheduled(
      'drizzle-module-always-fail',
      async () => {
        throw new Error('module permanent failure');
      },
      { retry: [50, 100] },
    );

    hooks.scheduled('drizzle-query-dlq', async (ctx) => {
      const rows = ctx.sql
        .exec(
          'SELECT taskId, attempts, error FROM _wskit_scheduled_dlq ORDER BY failedAt DESC LIMIT 1',
        )
        .toArray() as { taskId: string; attempts: number; error: string }[];
      const row = rows[0];
      if (row) {
        const err = JSON.parse(row.error) as { message: string };
        ctx.broadcast('module-dlq-result', {
          taskId: row.taskId,
          attempts: row.attempts,
          error: err.message,
        });
      }
    });

    return () => ({
      insert(data) {
        const [row] = db.insert(records).values(data).returning().all();
        return row!;
      },
      findAll() {
        return db.select().from(records).orderBy(records.id).all();
      },
      findById(id) {
        return db.select().from(records).where(eq(records.id, id)).get();
      },
      deleteById(id) {
        const deleted = db.delete(records).where(eq(records.id, id)).returning().all();
        return deleted.length > 0;
      },
      count() {
        const [row] = db.select({ value: count() }).from(records).all();
        return row?.value ?? 0;
      },
      getMessageCount() {
        return messageCount;
      },
      getOutgoingCount() {
        return outgoingCount;
      },
      getDisconnectCount() {
        return disconnectCount;
      },
      getLastGeneratedId() {
        return lastGeneratedId;
      },
      getLastState() {
        return lastState;
      },
      getShutdownCount() {
        return (
          db.select().from(moduleMeta).where(eq(moduleMeta.key, 'shutdown_count')).get()?.value ?? 0
        );
      },
    });
  },
});
