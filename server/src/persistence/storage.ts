import type { SQLProvider } from '~/context.ts';

// ── DDL ────────────────────────────────────────────────────────────────────

const CREATE_MEMBERSHIPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_channel_memberships (
    identity      TEXT NOT NULL,
    channel_name  TEXT NOT NULL,
    channel_scope TEXT NOT NULL DEFAULT '',
    joined_at     INTEGER NOT NULL,
    PRIMARY KEY (identity, channel_name, channel_scope)
  )
`;

const CREATE_MEMBERSHIPS_IDENTITY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_channel_memberships_identity
  ON __wskit_channel_memberships (identity)
`;

const CREATE_MEMBERSHIPS_CHANNEL_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_channel_memberships_channel
  ON __wskit_channel_memberships (channel_name, channel_scope)
`;

const CREATE_TAGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_tags (
    identity   TEXT NOT NULL,
    group_name TEXT NOT NULL,
    key        TEXT NOT NULL,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (identity, group_name, key)
  )
`;

const CREATE_TAGS_IDENTITY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_tags_identity
  ON __wskit_tags (identity)
`;

const CREATE_TAGS_GROUP_KEY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_tags_group_key
  ON __wskit_tags (group_name, key)
`;

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
 * about the `__wskit_tags` table being absent.
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
  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_channel_memberships
        (identity, channel_name, channel_scope, joined_at)
      VALUES (?, ?, ?, ?)
    `,
    identity,
    channelName,
    scopeToDb(channelScope),
    joinedAt,
  );
}

/**
 * Delete a single durable membership row. Called on a true leave (client
 * `__unsubscribe__`, `removeMember`, kick) of a persistent channel.
 */
export function deleteMembership(
  sql: Pick<SQLProvider, 'exec'>,
  identity: string,
  channelName: string,
  channelScope: string | null,
): void {
  sql.exec(
    `
      DELETE FROM __wskit_channel_memberships
      WHERE identity = ? AND channel_name = ? AND channel_scope = ?
    `,
    identity,
    channelName,
    scopeToDb(channelScope),
  );
}

/**
 * Read every durable membership for one identity. Used on accept to restore
 * the user's persistent channels before `onConnect` fires.
 */
export function listMembershipsByIdentity(
  sql: Pick<SQLProvider, 'exec'>,
  identity: string,
): readonly DurableMembership[] {
  const rows = sql
    .exec<RawMembershipRow>(
      `
        SELECT channel_name, channel_scope, joined_at
        FROM __wskit_channel_memberships
        WHERE identity = ?
      `,
      identity,
    )
    .toArray();
  return rows.map((row) => ({
    channelName: row.channel_name,
    channelScope: scopeFromDb(row.channel_scope),
    joinedAt: row.joined_at,
  }));
}

/** True when a durable membership row exists for this identity and channel scope. */
export function membershipExists(
  sql: Pick<SQLProvider, 'exec'>,
  identity: string,
  channelName: string,
  channelScope: string | null,
): boolean {
  return (
    sql
      .exec(
        `
          SELECT 1 FROM __wskit_channel_memberships
          WHERE identity = ? AND channel_name = ? AND channel_scope = ?
          LIMIT 1
        `,
        identity,
        channelName,
        scopeToDb(channelScope),
      )
      .toArray().length > 0
  );
}

/**
 * Delete every membership row for one identity. Used by `purgeIdentity`.
 */
export function purgeMembershipsByIdentity(sql: Pick<SQLProvider, 'exec'>, identity: string): void {
  sql.exec('DELETE FROM __wskit_channel_memberships WHERE identity = ?', identity);
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
  sql.exec(
    `
      DELETE FROM __wskit_channel_memberships
      WHERE channel_name = ? AND channel_scope = ?
    `,
    channelName,
    scopeToDb(channelScope),
  );
}

// ── Tags ───────────────────────────────────────────────────────────────────

/**
 * Delete every persistent tag row for one identity. Used by `purgeIdentity`.
 * Safe to call even when no rows exist for the identity.
 */
export function purgeTagsByIdentity(sql: Pick<SQLProvider, 'exec'>, identity: string): void {
  sql.exec('DELETE FROM __wskit_tags WHERE identity = ?', identity);
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
