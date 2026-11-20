import type { SQLProvider } from '@livething/server';
import type { CollaborationStorage, DocRef } from '~/doc/storage.ts';

const TABLE = 'livething_collaboration_updates';

interface UpdateRow {
  seq: number;
  part: number;
  data: ArrayBuffer | Uint8Array;
}

function keyOf(doc: DocRef): string {
  return `${doc.type}:${doc.id}`;
}

function bytesOf(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * The default storage: one table in the server's own SQL (`ctx.sql`), so it works on Node and
 * on Cloudflare with no setup. An update bigger than a row may hold is kept in several rows.
 */
export function sqlStorage(sql: SQLProvider): CollaborationStorage {
  let ready = false;
  // Leave room in the row for the doc key and the numbers.
  const partBytes = Math.max(1024, Math.min(1024 * 1024, Math.floor(sql.limits.maxValueBytes / 2)));

  function setup(): void {
    if (ready) return;

    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (doc TEXT NOT NULL, seq INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (doc, seq, part))`,
    );
    ready = true;
  }

  function write(key: string, seq: number, update: Uint8Array): void {
    for (let part = 0, at = 0; at < update.length || part === 0; part += 1, at += partBytes) {
      sql.exec(
        `INSERT INTO ${TABLE} (doc, seq, part, data) VALUES (?, ?, ?, ?)`,
        key,
        seq,
        part,
        update.subarray(at, at + partBytes),
      );
    }
  }

  return {
    load(doc) {
      setup();
      const key = keyOf(doc);
      const rows = sql
        .exec<UpdateRow>(
          `SELECT seq, part, data FROM ${TABLE} WHERE doc = ? ORDER BY seq, part`,
          key,
        )
        .toArray();

      const updates: Uint8Array[] = [];
      let seq = 0;
      let pieces: Uint8Array[] = [];
      for (const row of rows) {
        if (row.seq !== seq && pieces.length > 0) updates.push(join(pieces));
        if (row.seq !== seq) pieces = [];

        seq = row.seq;
        pieces.push(bytesOf(row.data));
      }

      if (pieces.length > 0) updates.push(join(pieces));

      return updates;
    },
    append(doc, update) {
      setup();
      const key = keyOf(doc);
      sql.transaction(() => {
        const last = sql
          .exec<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM ${TABLE} WHERE doc = ?`, key)
          .one();
        write(key, (last?.seq ?? 0) + 1, update);
      });
    },
    compact(doc, state) {
      setup();
      const key = keyOf(doc);
      sql.transaction(() => {
        sql.exec(`DELETE FROM ${TABLE} WHERE doc = ?`, key);
        write(key, 1, state);
      });
    },
  };
}

function join(pieces: readonly Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0]!.slice();

  const out = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }

  return out;
}
