import type { SQLProvider } from '@livething/server';
import type { CollaborationStorage, DocRef } from '~/doc/storage.ts';
import type { VersionInfo } from '~/doc/wire.ts';

const UPDATES = 'livething_collaboration_updates';
const VERSIONS = 'livething_collaboration_versions';
const VERSION_PARTS = 'livething_collaboration_version_parts';

/** Where the server keeps docs: their updates, and their saved versions. */
export interface ServerStorage extends CollaborationStorage {
  /** Keep a version of a doc: its info, and `state`, one update that holds the whole doc. */
  saveVersion(doc: DocRef, version: VersionInfo, state: Uint8Array): void | Promise<void>;
  /** A doc's versions, newest first. */
  listVersions(doc: DocRef): readonly VersionInfo[] | Promise<readonly VersionInfo[]>;
  /** The state of one version, or `null` when the doc has no version with that ID. */
  readVersion(doc: DocRef, id: string): Uint8Array | null | Promise<Uint8Array | null>;
}

interface PartRow {
  data: ArrayBuffer | Uint8Array;
}

interface UpdateRow extends PartRow {
  seq: number;
}

interface VersionRow {
  id: string;
  label: string;
  author: string | null;
  created_at: number;
}

function keyOf(doc: DocRef): string {
  return `${doc.type}:${doc.id}`;
}

function bytesOf(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * The default storage: tables in the server's own SQL (`ctx.sql`), so it works on Node and on
 * Cloudflare with no setup. An update or a version bigger than a row may hold is kept in
 * several rows.
 */
export function sqlStorage(sql: SQLProvider): ServerStorage {
  let ready = false;
  // Leave room in the row for the doc key and the numbers.
  const partBytes = Math.max(1024, Math.min(1024 * 1024, Math.floor(sql.limits.maxValueBytes / 2)));

  function setup(): void {
    if (ready) return;

    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${UPDATES} (doc TEXT NOT NULL, seq INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (doc, seq, part))`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${VERSIONS} (doc TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, author TEXT, created_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (doc, id))`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${VERSION_PARTS} (doc TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (doc, id, part))`,
    );
    ready = true;
  }

  /** Call `each` with every row-sized piece of `bytes`, and its index. */
  function pieces(bytes: Uint8Array, each: (piece: Uint8Array, part: number) => void): void {
    for (let part = 0, at = 0; at < bytes.length || part === 0; part += 1, at += partBytes) {
      each(bytes.subarray(at, at + partBytes), part);
    }
  }

  function writeUpdate(key: string, seq: number, update: Uint8Array): void {
    pieces(update, (piece, part) =>
      sql.exec(
        `INSERT INTO ${UPDATES} (doc, seq, part, data) VALUES (?, ?, ?, ?)`,
        key,
        seq,
        part,
        piece,
      ),
    );
  }

  return {
    load(doc) {
      setup();
      const rows = sql
        .exec<UpdateRow>(
          `SELECT seq, part, data FROM ${UPDATES} WHERE doc = ? ORDER BY seq, part`,
          keyOf(doc),
        )
        .toArray();

      const updates: Uint8Array[] = [];
      let seq = 0;
      let parts: Uint8Array[] = [];
      for (const row of rows) {
        if (row.seq !== seq && parts.length > 0) updates.push(join(parts));
        if (row.seq !== seq) parts = [];

        seq = row.seq;
        parts.push(bytesOf(row.data));
      }

      if (parts.length > 0) updates.push(join(parts));

      return updates;
    },
    append(doc, update) {
      setup();
      const key = keyOf(doc);
      sql.transaction(() => {
        const last = sql
          .exec<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM ${UPDATES} WHERE doc = ?`, key)
          .one();
        writeUpdate(key, (last?.seq ?? 0) + 1, update);
      });
    },
    compact(doc, state) {
      setup();
      const key = keyOf(doc);
      sql.transaction(() => {
        sql.exec(`DELETE FROM ${UPDATES} WHERE doc = ?`, key);
        writeUpdate(key, 1, state);
      });
    },
    saveVersion(doc, version, state) {
      setup();
      const key = keyOf(doc);
      sql.transaction(() => {
        sql.exec(
          `INSERT INTO ${VERSIONS} (doc, id, label, author, created_at) VALUES (?, ?, ?, ?, ?)`,
          key,
          version.id,
          version.label,
          version.author,
          version.createdAt,
        );
        pieces(state, (piece, part) =>
          sql.exec(
            `INSERT INTO ${VERSION_PARTS} (doc, id, part, data) VALUES (?, ?, ?, ?)`,
            key,
            version.id,
            part,
            piece,
          ),
        );
      });
    },
    listVersions(doc) {
      setup();
      return sql
        .exec<VersionRow>(
          `SELECT id, label, author, created_at FROM ${VERSIONS} WHERE doc = ? ORDER BY rowid DESC`,
          keyOf(doc),
        )
        .toArray()
        .map((row) => ({
          id: row.id,
          label: row.label,
          createdAt: row.created_at,
          author: row.author,
        }));
    },
    readVersion(doc, id) {
      setup();
      const rows = sql
        .exec<PartRow>(
          `SELECT data FROM ${VERSION_PARTS} WHERE doc = ? AND id = ? ORDER BY part`,
          keyOf(doc),
          id,
        )
        .toArray();

      return rows.length > 0 ? join(rows.map((row) => bytesOf(row.data))) : null;
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
