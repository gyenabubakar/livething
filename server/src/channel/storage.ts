import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import type { SQLProvider } from '~/context.ts';

const CREATE_MEMBERSHIPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_channel_memberships (
    user_id       TEXT NOT NULL,
    channel_name  TEXT NOT NULL,
    channel_family TEXT NOT NULL DEFAULT '',
    joined_at     INTEGER NOT NULL,
    -- JSON blob { meta }. New per-row fields go here without a migration.
    metadata      TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, channel_name, channel_family)
  )
`;

const CREATE_MEMBERSHIPS_USER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_channel_memberships_user
  ON __livething_channel_memberships (user_id)
`;

const CREATE_MEMBERSHIPS_CHANNEL_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_channel_memberships_channel
  ON __livething_channel_memberships (channel_name, channel_family)
`;

// All three DDL statements in one multi-statement string. Cloudflare's SQL
// `exec` accepts semicolon-separated statements, so this is one round trip
// instead of three.
// @__PURE__ tells the bundler this call has no side effects, so it can be
// dropped when nothing imports this const — otherwise a bundler must keep
// any module-scope function call, and every DDL string comes along for
// the ride even when a consumer only wants an unrelated query helper.
const MEMBERSHIP_SCHEMA_SQL = /* @__PURE__ */ [
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
}

type RawMembershipRow = {
  channel_name: string;
  channel_family: string;
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

/** A membership row to write: the key plus the joining connection's meta. */
export interface MembershipInsert extends MembershipKey {
  /** Shown to peers as the member's meta while the member is offline. */
  meta?: Record<string, unknown>;
}

/** The stored state of one membership row. */
export interface StoredMembership {
  meta: Record<string, unknown>;
}

/**
 * Insert or replace a durable membership row. Called on a successful subscribe
 * to a persistent channel.
 */
export function insertMembership(sql: Pick<SQLProvider, 'exec'>, row: MembershipInsert): void {
  sql.exec(
    `
      INSERT OR REPLACE INTO __livething_channel_memberships
        (user_id, channel_name, channel_family, joined_at, metadata)
      VALUES (?, ?, ?, ?, ?)
    `,
    row.userId,
    row.channelName,
    familyToDb(row.channelFamily),
    Date.now(),
    serializeJsonOrThrow({ meta: row.meta ?? {} }, `Channel membership meta for "${row.userId}"`),
  );
}

/**
 * Delete a single durable membership row. Called on a true leave (client
 * `__unsubscribe__`, a `kick`) of a persistent channel.
 */
export function deleteMembership(sql: Pick<SQLProvider, 'exec'>, key: MembershipKey): void {
  sql.exec(
    `
      DELETE FROM __livething_channel_memberships
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
        SELECT channel_name, channel_family
        FROM __livething_channel_memberships
        WHERE user_id = ?
      `,
      userId,
    )
    .toArray();
  return rows.map((row) => ({
    channelName: row.channel_name,
    channelFamily: familyFromDb(row.channel_family),
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
        SELECT user_id FROM __livething_channel_memberships
        WHERE channel_name = ? AND channel_family = ?
      `,
      channelName,
      familyToDb(channelFamily),
    )
    .toArray()
    .map((row) => row.user_id);
}

/** Read every durable member of one channel with its stored meta. */
export function listMembersByChannel(
  sql: Pick<SQLProvider, 'exec'>,
  channelName: string,
  channelFamily: string | null,
): (StoredMembership & { userId: string })[] {
  return sql
    .exec<{ user_id: string; metadata: string }>(
      `
        SELECT user_id, metadata FROM __livething_channel_memberships
        WHERE channel_name = ? AND channel_family = ?
      `,
      channelName,
      familyToDb(channelFamily),
    )
    .toArray()
    .map((row) => ({ userId: row.user_id, ...parseStoredMembership(row.metadata) }));
}

/** Read one durable membership row, or `undefined` when the user has none. */
export function readMembership(
  sql: Pick<SQLProvider, 'exec'>,
  key: MembershipKey,
): StoredMembership | undefined {
  const row = sql
    .exec<{ metadata: string }>(
      `
        SELECT metadata FROM __livething_channel_memberships
        WHERE user_id = ? AND channel_name = ? AND channel_family = ?
        LIMIT 1
      `,
      key.userId,
      key.channelName,
      familyToDb(key.channelFamily),
    )
    .toArray()[0];

  return row ? parseStoredMembership(row.metadata) : undefined;
}

/**
 * Delete every membership row for one user. Used by `purgeUser`.
 */
export function purgeMembershipsByUser(sql: Pick<SQLProvider, 'exec'>, userId: string): void {
  sql.exec('DELETE FROM __livething_channel_memberships WHERE user_id = ?', userId);
}

/**
 * Delete every membership row for one channel. Used by boot-time cleanup
 * when a channel is removed or stops being `membership: 'persistent'` between deploys.
 */
export function deleteMembershipsByChannel(
  sql: Pick<SQLProvider, 'exec'>,
  channelName: string,
  channelFamily: string | null,
): void {
  sql.exec(
    `
      DELETE FROM __livething_channel_memberships
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

function parseStoredMembership(raw: string): StoredMembership {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  const fields = isPlainObject(parsed) ? parsed : {};
  return {
    meta: isPlainObject(fields.meta) ? fields.meta : {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
