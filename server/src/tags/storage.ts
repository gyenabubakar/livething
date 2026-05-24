import type { SQLProvider } from '~/context.ts';

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
  identity: string;
  group: string;
  key: string;
  addedAt?: number;
}

/**
 * Insert or replace a durable tag row for the given identity. Called when
 * `ctx.tags.persistent(group).add(key)` runs.
 */
export function insertTag(sql: Pick<SQLProvider, 'exec'>, input: InsertTagInput): void {
  const addedAt = input.addedAt ?? Date.now();
  sql.exec(
    `
      INSERT OR REPLACE INTO __wskit_tags
        (identity, group_name, key, added_at)
      VALUES (?, ?, ?, ?)
    `,
    input.identity,
    input.group,
    input.key,
    addedAt,
  );
}

export interface DeleteTagInput {
  identity: string;
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
      WHERE identity = ? AND group_name = ? AND key = ?
    `,
    input.identity,
    input.group,
    input.key,
  );
}

/**
 * Read every durable tag for one identity. Used on accept to restore the
 * persistent tag set onto a fresh socket.
 */
export function listTagsByIdentity(
  sql: Pick<SQLProvider, 'exec'>,
  identity: string,
): readonly DurableTag[] {
  const rows = sql
    .exec<RawTagRow>(
      `
        SELECT group_name, key, added_at
        FROM __wskit_tags
        WHERE identity = ?
      `,
      identity,
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

/** Internal — used by integration paths that need the raw query. */
export const _internal = {
  SELECT_TAGS_BY_GROUP_SQL: `
    SELECT identity, key, added_at
    FROM __wskit_tags
    WHERE group_name = ?
  `,
};
