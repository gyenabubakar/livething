import { ValidationFailed } from '@wskit/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import { addConnectionTag } from '~/_engine/runtime/tag-index.ts';
import { deleteTag, listTagsByUser } from '~/tags/storage.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { Logger, SQLProvider } from '~/context.ts';
import type { Validator } from '~/types.ts';

/**
 * Put a user's saved persistent tags back into the live tag index.
 *
 * Runs on a fresh connect (via auto-rejoin) and on a hibernation wake, where
 * the per-connection snapshot only carries ephemeral tags. Reading by user id
 * means a tag dropped for the whole user while this socket slept does not
 * come back.
 */
export interface RestorePersistentTagsOptions {
  sql: Pick<SQLProvider, 'exec'>;
  tagMembers: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
  connection: EngineRuntimeTypes.RuntimeConnection;
  /**
   * Is this persistent group still declared in the contract? Distinct from
   * `getSchema` returning undefined, which also happens for a declared group
   * with no schema. When omitted, every group is treated as declared.
   */
  isGroupDeclared?: (group: string) => boolean;
  /** Returns a group's validator, or undefined when it has none. */
  getSchema?: (group: string) => Validator | undefined;
  logger?: Pick<Logger, 'error'>;
}

export function restorePersistentTags(opts: RestorePersistentTagsOptions): void {
  const { sql, tagMembers, connection } = opts;
  if (!connection.userId) return;

  for (const tag of listTagsByUser(sql, connection.userId)) {
    if (opts.isGroupDeclared && !opts.isGroupDeclared(tag.group)) {
      // The group was removed from the contract since this row was written.
      // Drop it from the live index and delete it from storage so it stops
      // coming back on every future connect.
      deleteTag(sql, { userId: connection.userId, group: tag.group, key: tag.key });
      opts.logger?.error(
        '[wskit] dropped a stored persistent tag whose group is no longer declared',
        { group: tag.group },
      );
      continue;
    }

    const schema = opts.getSchema?.(tag.group);
    if (schema) {
      try {
        validateValue(schema, tag.key, `tag persistent:${tag.group}`);
      } catch (error) {
        // Only a genuine schema mismatch drops the row. A config error (e.g. an
        // async validator) or any other throw propagates rather than silently
        // deleting valid persisted data.
        if (!ValidationFailed.matches(error)) throw error;

        deleteTag(sql, { userId: connection.userId, group: tag.group, key: tag.key });
        opts.logger?.error('[wskit] dropped a stored persistent tag that failed validation', {
          group: tag.group,
          error: error.detail.issues[0]?.message ?? 'validation failed',
        });
        continue;
      }
    }

    addConnectionTag(tagMembers, connection, {
      kind: 'persistent',
      group: tag.group,
      key: tag.key,
    });
  }
}
