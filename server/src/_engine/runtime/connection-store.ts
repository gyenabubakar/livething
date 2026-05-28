import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import type { SQLProvider } from '~/context.ts';
import type { RuntimeConnection } from './types.ts';

const CREATE_CONNECTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_connections (
    connection_id         TEXT PRIMARY KEY,
    identity              TEXT NOT NULL,
    meta                  TEXT NOT NULL,
    ephemeral_tags        TEXT NOT NULL DEFAULT '[]',
    ephemeral_memberships TEXT NOT NULL DEFAULT '[]',
    active_stream_ids     TEXT NOT NULL DEFAULT '[]',
    metadata              TEXT NOT NULL DEFAULT '{}'
  )
`;

const CREATE_CONNECTIONS_IDENTITY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_connections_identity
  ON __wskit_connections (identity)
`;

/**
 * One row of the ephemeral-tag JSON column. Each entry is one
 * `(group, key)` pair the connection currently holds in the ephemeral
 * storage area.
 */
export interface StoredEphemeralTag {
  group: string;
  key: string;
}

/**
 * The shape persisted into the `__wskit_connections` row. The engine writes one
 * row per live connection and reads it back on hibernation wake.
 */
export interface StoredConnectionRow {
  connection_id: string;
  identity: string;
  meta: Record<string, unknown>;
  ephemeral_tags: readonly StoredEphemeralTag[];
  ephemeral_memberships: readonly { channelName: string; channelScope: string | null }[];
  active_stream_ids: readonly string[];
}

type RawRow = {
  connection_id: string;
  identity: string;
  meta: string;
  ephemeral_tags: string;
  ephemeral_memberships: string;
  active_stream_ids: string;
};

// Table + index bundled — one round trip instead of two.
const CONNECTION_SCHEMA_SQL = `${CREATE_CONNECTIONS_TABLE_SQL};\n${CREATE_CONNECTIONS_IDENTITY_INDEX_SQL}`;

/**
 * Create the table and identity index used to persist per-connection state
 * across hibernation cycles. Idempotent — safe to call on every engine boot.
 */
export function ensureConnectionSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(CONNECTION_SCHEMA_SQL);
}

/**
 * Build the row payload from the in-memory connection record. Centralised so
 * the connect, wake, and per-state-change write paths all agree on the shape.
 */
export function buildConnectionRow(connection: RuntimeConnection): StoredConnectionRow {
  const ephemeral_tags: StoredEphemeralTag[] = [];
  for (const [group, keys] of connection.tags.ephemeral) {
    for (const key of keys) ephemeral_tags.push({ group, key });
  }
  return {
    connection_id: connection.id,
    identity: connection.identity,
    meta: connection.meta,
    ephemeral_tags,
    ephemeral_memberships: [...connection.channelMemberships.values()],
    active_stream_ids: [...(connection.activeStreamIds ?? [])],
  };
}

/**
 * Write (or replace) one connection row. Used for the initial insert on
 * accept, on each state change, and on the post-onConnect flush.
 */
export function writeConnectionRow(sql: Pick<SQLProvider, 'exec'>, row: StoredConnectionRow): void {
  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_connections
        (connection_id, identity, meta, ephemeral_tags, ephemeral_memberships, active_stream_ids)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    row.connection_id,
    row.identity,
    serializeJsonOrThrow(row.meta, `Connection meta for "${row.connection_id}"`),
    JSON.stringify(row.ephemeral_tags),
    JSON.stringify(row.ephemeral_memberships),
    JSON.stringify(row.active_stream_ids),
  );
}

/**
 * Read one connection row by id, or `null` when the row no longer exists
 * (e.g. it was reconciled away because the platform forgot about the socket).
 */
export function readConnectionRow(
  sql: Pick<SQLProvider, 'exec'>,
  connectionId: string,
): StoredConnectionRow | null {
  const raw = sql
    .exec<RawRow>(
      `
        SELECT connection_id, identity, meta, ephemeral_tags, ephemeral_memberships, active_stream_ids
        FROM __wskit_connections
        WHERE connection_id = ?
      `,
      connectionId,
    )
    .one();
  if (!raw) return null;
  return {
    connection_id: raw.connection_id,
    identity: raw.identity,
    meta: parseObject(raw.meta),
    ephemeral_tags: parseEphemeralTagArray(raw.ephemeral_tags),
    ephemeral_memberships: parseMembershipArray(raw.ephemeral_memberships),
    active_stream_ids: parseStringArray(raw.active_stream_ids),
  };
}

/**
 * Delete one connection row on real disconnect.
 */
export function deleteConnectionRow(sql: Pick<SQLProvider, 'exec'>, connectionId: string): void {
  sql.exec('DELETE FROM __wskit_connections WHERE connection_id = ?', connectionId);
}

/**
 * Engine-boot cleanup. Deletes every row whose connection id is not in the
 * surviving set. An empty set wipes the table — the right behaviour when no
 * sockets carried over (non-hibernating adapter, or hibernating adapter that
 * lost every socket). With hibernation on, the surviving set carries the ids
 * of sockets the platform still holds, so their rows are kept and only true
 * orphans are dropped.
 */
export function reconcileConnectionRows(
  sql: Pick<SQLProvider, 'exec'>,
  surviving: ReadonlySet<string>,
): void {
  if (surviving.size === 0) {
    sql.exec('DELETE FROM __wskit_connections');
    return;
  }
  const placeholders = Array.from({ length: surviving.size }, () => '?').join(', ');
  sql.exec(
    `DELETE FROM __wskit_connections WHERE connection_id NOT IN (${placeholders})`,
    ...surviving,
  );
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function parseStringArray(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    // fall through
  }
  return [];
}

function parseEphemeralTagArray(raw: string): readonly StoredEphemeralTag[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.group !== 'string' || typeof record.key !== 'string') return [];
      return [{ group: record.group, key: record.key }];
    });
  } catch {
    return [];
  }
}

function parseMembershipArray(
  raw: string,
): readonly { channelName: string; channelScope: string | null }[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.channelName !== 'string') return [];
      const scope =
        typeof record.channelScope === 'string'
          ? record.channelScope
          : record.channelScope === null
            ? null
            : null;
      return [{ channelName: record.channelName, channelScope: scope }];
    });
  } catch {
    return [];
  }
}
