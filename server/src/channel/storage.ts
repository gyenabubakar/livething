import type { SQLProvider } from '~/context.ts';

const CREATE_MEMBERSHIPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_channel_memberships (
    user_id       TEXT NOT NULL,
    channel_name  TEXT NOT NULL,
    channel_family TEXT NOT NULL DEFAULT '',
    joined_at     INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata      TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, channel_name, channel_family)
  )
`;

const CREATE_MEMBERSHIPS_USER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_channel_memberships_user
  ON __wskit_channel_memberships (user_id)
`;

const CREATE_MEMBERSHIPS_CHANNEL_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_channel_memberships_channel
  ON __wskit_channel_memberships (channel_name, channel_family)
`;

// All three DDL statements in one multi-statement string. Cloudflare's SQL
// `exec` accepts semicolon-separated statements, so this is one round trip
// instead of three.
const MEMBERSHIP_SCHEMA_SQL = [
  CREATE_MEMBERSHIPS_TABLE_SQL,
  CREATE_MEMBERSHIPS_USER_INDEX_SQL,
  CREATE_MEMBERSHIPS_CHANNEL_INDEX_SQL,
].join(';\n');

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

/**
 * Create the durable channel-membership table and its indexes. Idempotent —
 * safe to call on every engine boot.
 */
export function ensureMembershipSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(MEMBERSHIP_SCHEMA_SQL);
}

export interface MembershipKey {
  userId: string;

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
        (user_id, channel_name, channel_family, joined_at)
      VALUES (?, ?, ?, ?)
    `,
    key.userId,
    key.channelName,
    familyToDb(key.channelFamily),
    joinedAt,
  );
}

/**
 * Delete a single durable membership row. Called on a true leave (client
 * `__unsubscribe__`, a revoking `kick`) of a persistent channel.
 */
export function deleteMembership(sql: Pick<SQLProvider, 'exec'>, key: MembershipKey): void {
  sql.exec(
    `
      DELETE FROM __wskit_channel_memberships
      WHERE user_id = ? AND channel_name = ? AND channel_family = ?
    `,
    key.userId,
    key.channelName,
    familyToDb(key.channelFamily),
  );
}

/**
 * Read every durable membership for one user. Used on accept to restore
 * the user's persistent channels before `onConnect` fires.
 */
export function listMembershipsByUser(
  sql: Pick<SQLProvider, 'exec'>,
  userId: string,
): readonly DurableMembership[] {
  const rows = sql
    .exec<RawMembershipRow>(
      `
        SELECT channel_name, channel_family, joined_at
        FROM __wskit_channel_memberships
        WHERE user_id = ?
      `,
      userId,
    )
    .toArray();
  return rows.map((row) => ({
    channelName: row.channel_name,
    channelFamily: familyFromDb(row.channel_family),
    joinedAt: row.joined_at,
  }));
}

/**
 * Read every user id with a durable membership in one channel — the full
 * roster including members that are currently offline. Used by inbox fan-out to
 * write a per-member copy for everyone owed the message.
 */
export function listIdentitiesByChannel(
  sql: Pick<SQLProvider, 'exec'>,
  channelName: string,
  channelFamily: string | null,
): string[] {
  return sql
    .exec<{ user_id: string }>(
      `
        SELECT user_id FROM __wskit_channel_memberships
        WHERE channel_name = ? AND channel_family = ?
      `,
      channelName,
      familyToDb(channelFamily),
    )
    .toArray()
    .map((row) => row.user_id);
}

/** True when a durable membership row exists for this user and channel. */
export function membershipExists(sql: Pick<SQLProvider, 'exec'>, key: MembershipKey): boolean {
  return (
    sql
      .exec(
        `
          SELECT 1 FROM __wskit_channel_memberships
          WHERE user_id = ? AND channel_name = ? AND channel_family = ?
          LIMIT 1
        `,
        key.userId,
        key.channelName,
        familyToDb(key.channelFamily),
      )
      .toArray().length > 0
  );
}

/**
 * Delete every membership row for one user. Used by `purgeUser`.
 */
export function purgeMembershipsByUser(sql: Pick<SQLProvider, 'exec'>, userId: string): void {
  sql.exec('DELETE FROM __wskit_channel_memberships WHERE user_id = ?', userId);
}

/**
 * Delete every membership row for one channel. Used by boot-time cleanup
 * when a channel is removed or marked `membership: 'ephemeral'` between deploys.
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
 * Maps in-code `null` family (static channel) to the empty string `''` on the
 * DB side. SQLite treats NULLs as distinct in UNIQUE/PK, so `null` would
 * break the `(user_id, channel_name, channel_family)` primary key for static
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
