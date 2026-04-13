import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const records = sqliteTable('records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  value: text('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type Record = typeof records.$inferSelect;
export type InsertRecord = typeof records.$inferInsert;
