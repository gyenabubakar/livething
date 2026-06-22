import type { SQLProvider } from '~/context.ts';

const CREATE_MEMBERSHIPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_channel_memberships (
    identity      TEXT NOT NULL,
    channel_name  TEXT NOT NULL,
    channel_family TEXT NOT NULL DEFAULT '',
    joined_at     INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata      TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (identity, channel_name, channel_family)
  )
`;

const CREATE_MEMBERSHIPS_IDENTITY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_channel_memberships_identity
  ON __wskit_channel_memberships (identity)
`;

const CREATE_MEMBERSHIPS_CHANNEL_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_channel_memberships_channel
  ON __wskit_channel_memberships (channel_name, channel_family)
`;

const CREATE_TAGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_tags (
    identity   TEXT NOT NULL,
    group_name TEXT NOT NULL,
    key        TEXT NOT NULL,
    added_at   INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata   TEXT NOT NULL DEFAULT '{}',
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

/**
 * A single durable channel membership row, returned with the engine-native
 * `null` family for static channels. Storage stores `''` and the read path
 * maps it back to `null` here.
 */
export interface DurableMembership {
  channelName: string;
  channelFamily: string | null;

  joinedAt: number;
}

type RawMembershipRow = {
  channel_name: string;
  channel_family: string;
  joined_at: number;
};

// All six DDL statements in one multi-statement string. Cloudflare's SQL
// `exec` accepts semicolon-separated statements, so this is one round trip
// instead of six.
const PERSISTENCE_SCHEMA_SQL = [
  CREATE_MEMBERSHIPS_TABLE_SQL,
  CREATE_MEMBERSHIPS_IDENTITY_INDEX_SQL,
  CREATE_MEMBERSHIPS_CHANNEL_INDEX_SQL,
  CREATE_TAGS_TABLE_SQL,
  CREATE_TAGS_IDENTITY_INDEX_SQL,
  CREATE_TAGS_GROUP_KEY_INDEX_SQL,
].join(';\n');

/**
 * Create the per-user durable tables and indexes. Idempotent — safe to call
 * on every engine boot.
 */
export function ensurePersistenceSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(PERSISTENCE_SCHEMA_SQL);
}

export interface MembershipKey {
  identity: string;

  channelName: string;
  channelFamily: string | null;
}

/**
 * Insert or replace a durable membership row. Called on a successful subscribe
 * to a persistent channel.
 */
export function insertMembership(
  sql: Pick<SQLProvider, 'exec'>,
  key: MembershipKey,
  joinedAt: number = Date.now(),
): void {
  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_channel_memberships
        (identity, channel_name, channel_family, joined_at)
      VALUES (?, ?, ?, ?)
    `,
    key.identity,
    key.channelName,
    familyToDb(key.channelFamily),
    joinedAt,
  );
}

/**
 * Delete a single durable membership row. Called on a true leave (client
 * `__unsubscribe__`, `removeMember`, kick) of a persistent channel.
 */
export function deleteMembership(sql: Pick<SQLProvider, 'exec'>, key: MembershipKey): void {
  sql.exec(
    `
      DELETE FROM __wskit_channel_memberships
      WHERE identity = ? AND channel_name = ? AND channel_family = ?
    `,
    key.identity,
    key.channelName,
    familyToDb(key.channelFamily),
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
        SELECT channel_name, channel_family, joined_at
        FROM __wskit_channel_memberships
        WHERE identity = ?
      `,
      identity,
    )
    .toArray();
  return rows.map((row) => ({
    channelName: row.channel_name,
    channelFamily: familyFromDb(row.channel_family),
    joinedAt: row.joined_at,
  }));
}

/** True when a durable membership row exists for this identity and channel. */
export function membershipExists(sql: Pick<SQLProvider, 'exec'>, key: MembershipKey): boolean {
  return (
    sql
      .exec(
        `
          SELECT 1 FROM __wskit_channel_memberships
          WHERE identity = ? AND channel_name = ? AND channel_family = ?
          LIMIT 1
        `,
        key.identity,
        key.channelName,
        familyToDb(key.channelFamily),
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
 * when a channel is removed or marked `persistent: false` between deploys.
 */
export function deleteMembershipsByChannel(
  sql: Pick<SQLProvider, 'exec'>,
  channelName: string,
  channelFamily: string | null,
): void {
  sql.exec(
    `
      DELETE FROM __wskit_channel_memberships
      WHERE channel_name = ? AND channel_family = ?
    `,
    channelName,
    familyToDb(channelFamily),
  );
}

/**
 * Delete every persistent tag row for one identity. Used by `purgeIdentity`.
 * Safe to call even when no rows exist for the identity.
 */
export function purgeTagsByIdentity(sql: Pick<SQLProvider, 'exec'>, identity: string): void {
  sql.exec('DELETE FROM __wskit_tags WHERE identity = ?', identity);
}

/**
 * Maps in-code `null` family (static channel) to the empty string `''` on the
 * DB side. SQLite treats NULLs as distinct in UNIQUE/PK, so `null` would
 * break the `(identity, channel_name, channel_family)` primary key for static
 * channels. `''` is the canonical "no family" marker on disk; in-engine code
 * never sees it.
 */
function familyToDb(scope: string | null): string {
  return scope ?? '';
}

/**
 * Maps DB `''` back to `null` for in-engine consumers. Any non-empty string
 * is a real family and passes through.
 */
function familyFromDb(scope: string): string | null {
  return scope === '' ? null : scope;
}
