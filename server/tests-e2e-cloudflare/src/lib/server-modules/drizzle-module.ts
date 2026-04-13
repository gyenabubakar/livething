import { defineModule } from '@wskit/server';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as v from 'valibot';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import * as schema from './schema.ts';
import { records } from './schema.ts';
import type { InsertRecord } from './schema.ts';

interface CfPlatform {
  ctx: { storage: DurableObjectStorage };
}

const DRIZZLE_KEY = Symbol('e2e:drizzle');

export interface DrizzleApi {
  insert(data: Omit<InsertRecord, 'id' | 'createdAt'>): schema.Record;
  findAll(): schema.Record[];
  findById(id: number): schema.Record | undefined;
  deleteById(id: number): boolean;
  count(): number;
}

export const Drizzle = defineModule<{ migrate: boolean }, DrizzleApi>({
  id: 'e2e:drizzle',
  key: DRIZZLE_KEY,
  requires: { storage: true },
  outgoing: {
    'drizzle-ready': v.object({ tables: v.array(v.string()) }),
  },

  setup(args, hooks) {
    let db: DrizzleSqliteDODatabase<typeof schema>;
    let messageCount = 0;

    hooks.onInit((ctx: { platform: CfPlatform }) => {
      db = drizzle(ctx.platform.ctx.storage, { schema });

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
    });

    hooks.onConnect((ctx) => {
      ctx.send('drizzle-ready', { tables: ['records'] });
    });

    hooks.onDisconnect((ctx) => {
      ctx.log.info('Drizzle module: client disconnected', { id: ctx.id });
    });

    hooks.onShutdown(() => {
      console.log('[drizzle-module] shutdown, processed', messageCount, 'messages');
    });

    hooks.onIncoming((message) => {
      messageCount++;
      return message;
    });

    hooks.onOutgoing((message) => {
      return message;
    });

    hooks.scheduled(
      'drizzle-vacuum',
      async (ctx: { broadcast: (e: string, p: unknown) => void }) => {
        ctx.broadcast('drizzle-vacuum-done', { timestamp: Date.now() });
      },
    );

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
    });
  },
});
