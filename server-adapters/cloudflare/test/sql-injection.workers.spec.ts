import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
// The REAL wskit durable-stream storage layer, imported from server source.
import * as Storage from '../../../server/src/_engine/stream-durable/storage.ts';
import type { SqlTestDO } from './worker.ts';

interface TestEnv {
  SQL_TEST_DO: DurableObjectNamespace<SqlTestDO>;
}

const ATTACK = `evil'); DROP TABLE __wskit_streams; --`;

// Adapt the real Durable Object SQLite handle to wskit's SqlExec interface.
function adapt(sql: SqlStorage) {
  return {
    exec(query: string, ...params: unknown[]) {
      return sql.exec(query, ...(params as never[]));
    },
  };
}

async function withDO<T>(name: string, fn: (sql: SqlStorage) => T): Promise<T> {
  const ns = (env as unknown as TestEnv).SQL_TEST_DO;
  const stub = ns.get(ns.idFromName(name));
  return runInDurableObject(stub, (instance) => fn(instance.sql));
}

describe('REAL workerd DO SQLite — injection cannot escape parameter binding', () => {
  it('malicious keys are stored as literal data; no table is dropped', async () => {
    await withDO('inject-1', (rawSql) => {
      const sql = adapt(rawSql);
      Storage.ensureDurableStreamSchema(sql);

      Storage.insertStream(sql, {
        identity: ATTACK,
        streamId: ATTACK,
        event: ATTACK,
        payload: '{}',
        kind: 'recorded',
        now: 1,
        channelKey: ATTACK,
      });

      // Table still exists — the DROP TABLE inside the payload never executed.
      const tables = rawSql
        .exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='__wskit_streams'`)
        .toArray();
      expect(tables).toHaveLength(1);

      // Row round-trips verbatim; the embedded quote did not break the INSERT.
      const row = Storage.readStream(sql, ATTACK, ATTACK);
      expect(row).not.toBeNull();
      expect(row!.identity).toBe(ATTACK);
      expect(row!.event).toBe(ATTACK);
      expect(row!.channelKey).toBe(ATTACK);

      // A different identity matches nothing — the `'` did not break the WHERE.
      expect(Storage.readStream(sql, 'someone-else', ATTACK)).toBeNull();
    });
  });

  it('append/count/delete driven by attacker keys keep both tables intact', async () => {
    await withDO('inject-2', (rawSql) => {
      const sql = adapt(rawSql);
      Storage.ensureDurableStreamSchema(sql);
      Storage.insertStream(sql, {
        identity: ATTACK,
        streamId: ATTACK,
        event: 'e',
        payload: '{}',
        kind: 'recorded',
        now: 1,
      });
      Storage.appendChunk(sql, {
        identity: ATTACK,
        streamId: ATTACK,
        seq: 1,
        messageId: ATTACK,
        payload: ATTACK,
        now: 1,
      });

      expect(Storage.countChunks(sql, ATTACK, ATTACK)).toBe(1);
      const chunks = Storage.readChunksSince(sql, {
        identity: ATTACK,
        streamId: ATTACK,
        since: 0,
      });
      expect(chunks[0]!.payload).toBe(ATTACK);

      Storage.deleteStream(sql, ATTACK, ATTACK);

      const names = rawSql
        .exec(`SELECT name FROM sqlite_master WHERE type='table'`)
        .toArray()
        .map((t) => t.name as string);
      expect(names).toContain('__wskit_streams');
      expect(names).toContain('__wskit_stream_chunks');
    });
  });
});
