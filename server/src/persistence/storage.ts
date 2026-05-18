import type { SQLProvider } from '~/context.ts';

// ── DDL ────────────────────────────────────────────────────────────────────

const CREATE_MEMBERSHIPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_channel_memberships (
    identity      TEXT NOT NULL,
    channel_name  TEXT NOT NULL,
    channel_scope TEXT NOT NULL DEFAULT '',
    joined_at     INTEGER NOT NULL,
    PRIMARY KEY (identity, channel_name, channel_scope)
  )
`;

const CREATE_MEMBERSHIPS_IDENTITY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_channel_memberships_identity
  ON _wskit_channel_memberships (identity)
`;

const CREATE_MEMBERSHIPS_CHANNEL_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_channel_memberships_channel
  ON _wskit_channel_memberships (channel_name, channel_scope)
`;

const CREATE_TAGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_tags (
    identity   TEXT NOT NULL,
    group_name TEXT NOT NULL,
    key        TEXT NOT NULL,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (identity, group_name, key)
  )
`;

const CREATE_TAGS_IDENTITY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_tags_identity
  ON _wskit_tags (identity)
`;

const CREATE_TAGS_GROUP_KEY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_tags_group_key
  ON _wskit_tags (group_name, key)
`;

// ── DML ────────────────────────────────────────────────────────────────────

const INSERT_MEMBERSHIP_SQL = `
  INSERT OR REPLACE INTO _wskit_channel_memberships
    (identity, channel_name, channel_scope, joined_at)
  VALUES (?, ?, ?, ?)
`;

const DELETE_MEMBERSHIP_SQL = `
  DELETE FROM _wskit_channel_memberships
  WHERE identity = ? AND channel_name = ? AND channel_scope = ?
`;

const SELECT_MEMBERSHIPS_BY_IDENTITY_SQL = `
  SELECT channel_name, channel_scope, joined_at
  FROM _wskit_channel_memberships
  WHERE identity = ?
`;

const DELETE_MEMBERSHIPS_BY_IDENTITY_SQL =
  'DELETE FROM _wskit_channel_memberships WHERE identity = ?';

const DELETE_MEMBERSHIPS_BY_CHANNEL_SQL = `
  DELETE FROM _wskit_channel_memberships
  WHERE channel_name = ? AND channel_scope = ?
`;

const DELETE_TAGS_BY_IDENTITY_SQL = 'DELETE FROM _wskit_tags WHERE identity = ?';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A single durable channel membership row, returned with the engine-native
 * `null` scope for static channels. Storage stores `''` and the read path
 * maps it back to `null` here.
 */
export interface DurableMembership {
  channelName: string;
  channelScope: string | null;
  joinedAt: number;
}

type RawMembershipRow = {
  channel_name: string;
  channel_scope: string;
  joined_at: number;
};

// ── Schema ─────────────────────────────────────────────────────────────────

/**
 * Create the per-user durable tables and indexes. Idempotent — safe to call
 * on every engine boot. Both tables are created together so a later phase
 * can drop tag rows for an identity during `purgeIdentity` without worrying
 * about the `_wskit_tags` table being absent.
 */
export function ensurePersistenceSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(CREATE_MEMBERSHIPS_TABLE_SQL);
  sql.exec(CREATE_MEMBERSHIPS_IDENTITY_INDEX_SQL);
  sql.exec(CREATE_MEMBERSHIPS_CHANNEL_INDEX_SQL);
  sql.exec(CREATE_TAGS_TABLE_SQL);
  sql.exec(CREATE_TAGS_IDENTITY_INDEX_SQL);
  sql.exec(CREATE_TAGS_GROUP_KEY_INDEX_SQL);
}

// ── Memberships ────────────────────────────────────────────────────────────

/**
 * Insert or replace a durable membership row. Called on a successful subscribe
 * to a persistent channel.
 */
export function insertMembership(
  sql: Pick<SQLProvider, 'exec'>,
  identity: string,
  channelName: string,
  channelScope: string | null,
  joinedAt: number = Date.now(),
): void {
  sql.exec(INSERT_MEMBERSHIP_SQL, identity, channelName, scopeToDb(channelScope), joinedAt);
}

/**
 * Delete a single durable membership row. Called on a true leave (client
 * `_unsubscribe`, `removeMember`, kick) of a persistent channel.
 */
export function deleteMembership(
  sql: Pick<SQLProvider, 'exec'>,
  identity: string,
  channelName: string,
  channelScope: string | null,
): void {
  sql.exec(DELETE_MEMBERSHIP_SQL, identity, channelName, scopeToDb(channelScope));
}

/**
 * Read every durable membership for one identity. Used on accept to restore
 * the user's persistent channels before `onConnect` fires.
 */
export function listMembershipsByIdentity(
  sql: Pick<SQLProvider, 'exec'>,
  identity: string,
): readonly DurableMembership[] {
  const rows = sql.exec<RawMembershipRow>(SELECT_MEMBERSHIPS_BY_IDENTITY_SQL, identity).toArray();
  return rows.map((row) => ({
    channelName: row.channel_name,
    channelScope: scopeFromDb(row.channel_scope),
    joinedAt: row.joined_at,
  }));
}

/**
 * Delete every membership row for one identity. Used by `purgeIdentity`.
 */
export function purgeMembershipsByIdentity(sql: Pick<SQLProvider, 'exec'>, identity: string): void {
  sql.exec(DELETE_MEMBERSHIPS_BY_IDENTITY_SQL, identity);
}

/**
 * Delete every membership row for one channel. Used by boot-time cleanup
 * when a channel is removed or marked `.persistent(false)` between deploys.
 */
export function deleteMembershipsByChannel(
  sql: Pick<SQLProvider, 'exec'>,
  channelName: string,
  channelScope: string | null,
): void {
  sql.exec(DELETE_MEMBERSHIPS_BY_CHANNEL_SQL, channelName, scopeToDb(channelScope));
}

// ── Tags ───────────────────────────────────────────────────────────────────

/**
 * Delete every persistent tag row for one identity. Used by `purgeIdentity`.
 * Safe to call even when no rows exist for the identity.
 */
export function purgeTagsByIdentity(sql: Pick<SQLProvider, 'exec'>, identity: string): void {
  sql.exec(DELETE_TAGS_BY_IDENTITY_SQL, identity);
}

// ── Scope mapping ──────────────────────────────────────────────────────────

/**
 * Maps in-code `null` scope (static channel) to the DB sentinel `''`.
 * SQLite treats NULLs as distinct in UNIQUE/PK, so `null` would break the
 * `(identity, channel_name, channel_scope)` primary key for static channels.
 * `''` works as the canonical "no scope" marker on the DB side; in-engine
 * code never sees it.
 */
function scopeToDb(scope: string | null): string {
  return scope ?? '';
}

/**
 * Maps DB `''` back to `null` for in-engine consumers. Any non-empty string
 * is a real family scope and passes through.
 */
function scopeFromDb(scope: string): string | null {
  return scope === '' ? null : scope;
}
