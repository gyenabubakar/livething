import type { SQLProvider } from '~/context.ts';

const CREATE_TAGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_tags (
    user_id    TEXT NOT NULL,
    group_name TEXT NOT NULL,
    key        TEXT NOT NULL,
    added_at   INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata   TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, group_name, key)
  )
`;

const CREATE_TAGS_USER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_tags_user
  ON __wskit_tags (user_id)
`;

const CREATE_TAGS_GROUP_KEY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_tags_group_key
  ON __wskit_tags (group_name, key)
`;

// All three DDL statements in one multi-statement string. Cloudflare's SQL
// `exec` accepts semicolon-separated statements, so this is one round trip
// instead of three.
// @__PURE__ lets the bundler drop this when unused; see channel/storage.ts.
const TAGS_SCHEMA_SQL = /* @__PURE__ */ [
  CREATE_TAGS_TABLE_SQL,
  CREATE_TAGS_USER_INDEX_SQL,
  CREATE_TAGS_GROUP_KEY_INDEX_SQL,
].join(';\n');

/**
 * Create the durable tags table and its indexes. Idempotent — safe to call
 * on every engine boot.
 */
export function ensureTagsSchema(sql: Pick<SQLProvider, 'exec'>): void {
  sql.exec(TAGS_SCHEMA_SQL);
}

/** One durable persistent-tag row, as the engine reads it. */
export interface DurableTag {
  group: string;
  key: string;
  addedAt: number;
}

type RawTagRow = {
  group_name: string;
  key: string;
  added_at: number;
};

export interface InsertTagInput {
  userId: string;
  group: string;
  key: string;
  addedAt?: number;
}

/**
 * Insert or replace a durable tag row for the given user. Called when
 * `ctx.tags.persistent(group).add(key)` runs.
 */
export function insertTag(sql: Pick<SQLProvider, 'exec'>, input: InsertTagInput): void {
  const addedAt = input.addedAt ?? Date.now();
  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_tags
        (user_id, group_name, key, added_at)
      VALUES (?, ?, ?, ?)
    `,
    input.userId,
    input.group,
    input.key,
    addedAt,
  );
}

export interface DeleteTagInput {
  userId: string;
  group: string;
  key: string;
}

/**
 * Delete one durable tag row. Called when
 * `ctx.tags.persistent(group).remove(key)` runs.
 */
export function deleteTag(sql: Pick<SQLProvider, 'exec'>, input: DeleteTagInput): void {
  sql.exec(
    `
      DELETE FROM __wskit_tags
      WHERE user_id = ? AND group_name = ? AND key = ?
    `,
    input.userId,
    input.group,
    input.key,
  );
}

/**
 * Read every durable tag for one user. Used on accept to restore the
 * persistent tag set onto a fresh socket.
 */
export function listTagsByUser(
  sql: Pick<SQLProvider, 'exec'>,
  userId: string,
): readonly DurableTag[] {
  const rows = sql
    .exec<RawTagRow>(
      `
        SELECT group_name, key, added_at
        FROM __wskit_tags
        WHERE user_id = ?
      `,
      userId,
    )
    .toArray();
  return rows.map((row) => ({
    group: row.group_name,
    key: row.key,
    addedAt: row.added_at,
  }));
}

/**
 * Read every durable tag row in one group. Used by boot cleanup to find
 * orphaned groups that no longer match a declared persistent group.
 */
export function listGroupNames(sql: Pick<SQLProvider, 'exec'>): readonly string[] {
  const rows = sql
    .exec<{ group_name: string }>('SELECT DISTINCT group_name FROM __wskit_tags')
    .toArray();
  return rows.map((row) => row.group_name);
}

/**
 * Delete every row of one group. Used by boot cleanup when a group is
 * removed between deploys.
 */
export function deleteGroup(sql: Pick<SQLProvider, 'exec'>, group: string): void {
  sql.exec('DELETE FROM __wskit_tags WHERE group_name = ?', group);
}

/**
 * Delete every persistent tag row for one user. Used by `purgeUser`.
 * Safe to call even when no rows exist for the user.
 */
export function purgeTagsByUser(sql: Pick<SQLProvider, 'exec'>, userId: string): void {
  sql.exec('DELETE FROM __wskit_tags WHERE user_id = ?', userId);
}
