import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import { chunkForBind } from '~/_engine/sql-batch.ts';
import type { SQLProvider } from '~/context.ts';
import type { RuntimeConnection } from './types.ts';

const CREATE_CONNECTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_connections (
    connection_id         TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL,
    meta                  TEXT NOT NULL,
    ephemeral_tags        TEXT NOT NULL DEFAULT '[]',
    ephemeral_memberships TEXT NOT NULL DEFAULT '[]',
    active_stream_ids     TEXT NOT NULL DEFAULT '[]',
    awareness             TEXT NOT NULL DEFAULT '{}',
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata              TEXT NOT NULL DEFAULT '{}'
  )
`;

const CREATE_CONNECTIONS_USER_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_connections_user_id
  ON __livething_connections (user_id)
`;

/**
 * One row of the ephemeral-tag JSON column. Each entry is one
 * `(group, key)` pair the connection currently holds in the ephemeral
 * storage area.
 */
interface StoredEphemeralTag {
  group: string;
  key: string;
}

/**
 * The shape persisted into the `__livething_connections` row. The engine writes one
 * row per live connection and reads it back on hibernation wake.
 */
export interface StoredConnectionRow {
  connection_id: string;
  user_id: string;
  meta: Record<string, unknown>;
  ephemeral_tags: readonly StoredEphemeralTag[];
  ephemeral_memberships: readonly { channelName: string; channelFamily: string | null }[];
  active_stream_ids: readonly string[];
  /** The connection's awareness state in each channel, keyed by channel membership key. */
  awareness?: Readonly<Record<string, StoredAwarenessEntry>>;
  /** Framework-owned JSON state reserved for connection-level features. */
  metadata?: Record<string, unknown>;
}

/** One awareness entry in a hibernation row. `state` and `meta` are kept as their JSON. */
export interface StoredAwarenessEntry {
  state: string;
  meta: string;
  updatedAt: number;
}

type RawRow = {
  connection_id: string;
  user_id: string;
  meta: string;
  ephemeral_tags: string;
  ephemeral_memberships: string;
  active_stream_ids: string;
  awareness: string;
  metadata: string;
};

// Table + index bundled — one round trip instead of two.
const CONNECTION_SCHEMA_SQL = `${CREATE_CONNECTIONS_TABLE_SQL};\n${CREATE_CONNECTIONS_USER_ID_INDEX_SQL}`;

/**
 * Create the table and user id index used to persist per-connection state
 * across hibernation cycles. Idempotent — safe to call on every engine boot.
 */
export function ensureConnectionSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(CONNECTION_SCHEMA_SQL);
}

/**
 * Build the row payload from the in-memory connection record. Centralised so
 * the connect, wake, and per-state-change write paths all agree on the shape.
 */
export function buildConnectionRow(
  connection: RuntimeConnection,
  awareness: Readonly<Record<string, StoredAwarenessEntry>> = {},
): StoredConnectionRow {
  const ephemeral_tags: StoredEphemeralTag[] = [];
  for (const [group, keys] of connection.tags.ephemeral) {
    for (const key of keys) ephemeral_tags.push({ group, key });
  }

  return {
    connection_id: connection.id,
    user_id: connection.userId,
    meta: connection.meta,
    ephemeral_tags,
    ephemeral_memberships: [...connection.channelMemberships.values()],
    active_stream_ids: [...(connection.activeStreamIds ?? [])],
    awareness,
    metadata: connection.resumeToken ? { resumeToken: connection.resumeToken } : {},
  };
}

/**
 * Write (or replace) one connection row. Used for the initial insert on
 * accept, on each state change, and on the post-onConnect flush.
 */
export function writeConnectionRow(sql: Pick<SQLProvider, 'exec'>, row: StoredConnectionRow): void {
  sql.exec(
    `
      INSERT OR REPLACE INTO __livething_connections
        (connection_id, user_id, meta, ephemeral_tags, ephemeral_memberships, active_stream_ids, awareness, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    row.connection_id,
    row.user_id,
    serializeJsonOrThrow(row.meta, `Connection meta for "${row.connection_id}"`),
    JSON.stringify(row.ephemeral_tags),
    JSON.stringify(row.ephemeral_memberships),
    JSON.stringify(row.active_stream_ids),
    JSON.stringify(row.awareness ?? {}),
    serializeJsonOrThrow(row.metadata ?? {}, `Connection metadata for "${row.connection_id}"`),
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
        SELECT connection_id, user_id, meta, ephemeral_tags, ephemeral_memberships, active_stream_ids, awareness, metadata
        FROM __livething_connections
        WHERE connection_id = ?
      `,
      connectionId,
    )
    .one();
  if (!raw) return null;

  return {
    connection_id: raw.connection_id,
    user_id: raw.user_id,
    meta: parseObject(raw.meta),
    ephemeral_tags: parseEphemeralTagArray(raw.ephemeral_tags),
    ephemeral_memberships: parseMembershipArray(raw.ephemeral_memberships),
    active_stream_ids: parseStringArray(raw.active_stream_ids),
    awareness: parseAwareness(raw.awareness),
    metadata: parseObject(raw.metadata),
  };
}

/**
 * Read every persisted connection row in one query, keyed by connection id.
 * The boot restore path wakes each surviving socket in turn; without this it
 * would issue one `SELECT` per socket.
 */
export function readAllConnectionRows(
  sql: Pick<SQLProvider, 'exec'>,
): Map<string, StoredConnectionRow> {
  const rows = sql
    .exec<RawRow>(
      `
        SELECT connection_id, user_id, meta, ephemeral_tags, ephemeral_memberships, active_stream_ids, awareness, metadata
        FROM __livething_connections
      `,
    )
    .toArray();
  const byId = new Map<string, StoredConnectionRow>();
  for (const raw of rows) {
    byId.set(raw.connection_id, {
      connection_id: raw.connection_id,
      user_id: raw.user_id,
      meta: parseObject(raw.meta),
      ephemeral_tags: parseEphemeralTagArray(raw.ephemeral_tags),
      ephemeral_memberships: parseMembershipArray(raw.ephemeral_memberships),
      active_stream_ids: parseStringArray(raw.active_stream_ids),
      awareness: parseAwareness(raw.awareness),
      metadata: parseObject(raw.metadata),
    });
  }

  return byId;
}

/**
 * Delete one connection row on real disconnect.
 */
export function deleteConnectionRow(sql: Pick<SQLProvider, 'exec'>, connectionId: string): void {
  sql.exec('DELETE FROM __livething_connections WHERE connection_id = ?', connectionId);
}

/**
 * Engine-boot cleanup. Deletes every row whose connection id is not in the
 * surviving set. An empty set wipes the table — the right behaviour when no
 * sockets carried over (non-hibernating adapter, or hibernating adapter that
 * lost every socket). With hibernation on, the surviving set carries the ids
 * of sockets the platform still holds, so their rows are kept and only true
 * orphans are dropped.
 *
 * Reads every stored id first (an unparameterised `SELECT`, so it has no
 * bound-parameter cap to worry about), works out the orphans in memory, then
 * deletes them in batches sized to the adapter's bound-parameter cap. A
 * Durable Object holding more live connections than that cap must still be
 * able to wake — binding one parameter per surviving id in a single
 * `NOT IN (...)` statement would fail above the cap.
 */
export function reconcileConnectionRows(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  surviving: ReadonlySet<string>,
): void {
  if (surviving.size === 0) {
    sql.exec('DELETE FROM __livething_connections');
    return;
  }

  const storedIds = sql
    .exec<{ connection_id: string }>('SELECT connection_id FROM __livething_connections')
    .toArray()
    .map((row) => row.connection_id);
  const orphanIds = storedIds.filter((id) => !surviving.has(id));
  if (orphanIds.length === 0) return;

  for (const batch of chunkForBind(orphanIds, 1, sql.limits)) {
    const placeholders = batch.map(() => '?').join(', ');
    sql.exec(
      `DELETE FROM __livething_connections WHERE connection_id IN (${placeholders})`,
      ...batch,
    );
  }
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

function parseAwareness(raw: string): Record<string, StoredAwarenessEntry> {
  const stored: Record<string, StoredAwarenessEntry> = {};
  for (const [key, value] of Object.entries(parseObject(raw))) {
    const entry = value as Partial<StoredAwarenessEntry> | null;
    if (
      typeof entry?.state === 'string' &&
      typeof entry.meta === 'string' &&
      typeof entry.updatedAt === 'number'
    ) {
      stored[key] = { state: entry.state, meta: entry.meta, updatedAt: entry.updatedAt };
    }
  }

  return stored;
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
): readonly { channelName: string; channelFamily: string | null }[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];

      const record = entry as Record<string, unknown>;
      if (typeof record.channelName !== 'string') return [];

      const scope = typeof record.channelFamily === 'string' ? record.channelFamily : null;

      return [{ channelName: record.channelName, channelFamily: scope }];
    });
  } catch {
    return [];
  }
}
