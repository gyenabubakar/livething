import {
  ChannelNotFound,
  RejoinRejected,
  rethrowIfConfigError,
  ValidationFailed,
} from '@wskit/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import { addConnectionTag } from '~/_engine/runtime/tag-index.ts';
import { deleteMembership, listMembershipsByUser } from '~/persistence/storage.ts';
import { deleteTag, listTagsByUser } from '~/tags/storage.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { Logger, SQLProvider } from '~/context.ts';
import type { Validator } from '~/types.ts';

export interface RejoinSubscribeOptions {
  channelName: string;

  channelFamily: string | null;

  payload: unknown;

  rejoining: boolean;
}

/**
 * Dependency bag for the auto-rejoin path. Mirrors the channel runtime bag
 * but adds the storage handle and the server-subscribe primitive entry point
 * so the rejoin runs without re-importing the engine.
 */
export interface RejoinRuntime {
  sql: Pick<SQLProvider, 'exec'>;

  tagMembers: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;

  /**
   * Server-side subscribe primitive (from #11). The rejoin path invokes this
   * for every durable membership the user has so the connection lands
   * back in the channel without a client `__subscribe__` frame. The `rejoining`
   * flag tells the subscribe flow to suppress `__memberJoin__` peer broadcasts
   * (the user is already a member of the group — only the new socket's
   * presence has changed).
   */
  subscribeConnectionAsServer(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: RejoinSubscribeOptions,
  ): Promise<void>;

  /**
   * Send a protocol-level frame addressed to the rejoining connection. Used
   * to deliver an `__error__` when the gate rejects a stored membership.
   */
  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: SendProtocolMessageOptions,
  ): void;

  /** Returns a persistent tag group's validator, or undefined when it has none. */
  getTagGroupSchema?(group: string): Validator | undefined;

  logger?: Pick<Logger, 'error'>;
}

/**
 * Auto-rejoin every persistent channel the connection's user was in.
 *
 * Runs once per accept, BEFORE `onConnect` fires, so user handlers see the
 * connection already in its old channels. For each durable membership the
 * engine re-runs the `revalidate` hook. On pass the connection is committed
 * via the server-subscribe primitive (`source: 'server'`), which sends
 * `__subscribeOk__` to the rejoining socket; `__memberJoin__` peer broadcasts
 * are suppressed because the user is still a member — peers see
 * `__memberOnline__` for the new socket's presence instead. On reject the
 * durable row is dropped and a `rejoin-rejected` `__error__` scoped to the
 * channel is sent to the new socket so the client knows that one channel did
 * not restore.
 *
 * Rows for channels that no longer exist (renamed or removed between
 * deploys) are skipped silently — boot cleanup is where those dead rows
 * get purged.
 *
 * No-ops:
 * - Empty user id (anonymous flow with no key to look rows up by).
 * - No rows for this user.
 *
 * @internal
 */
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
  /** Returns a group's validator, or undefined when it has none. */
  getSchema?: (group: string) => Validator | undefined;
  logger?: Pick<Logger, 'error'>;
}

export function restorePersistentTags(opts: RestorePersistentTagsOptions): void {
  const { sql, tagMembers, connection } = opts;
  if (!connection.userId) return;
  for (const tag of listTagsByUser(sql, connection.userId)) {
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

export async function autoRejoinIdentity(
  runtime: RejoinRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
): Promise<void> {
  if (!connection.userId) return;

  // Restore persistent tags first — channel auto-rejoin's check hook
  // can read them via `ctx.tags.persistent(...)`.
  restorePersistentTags({
    sql: runtime.sql,
    tagMembers: runtime.tagMembers,
    connection,
    getSchema: runtime.getTagGroupSchema,
    logger: runtime.logger,
  });

  const rows = listMembershipsByUser(runtime.sql, connection.userId);
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      await runtime.subscribeConnectionAsServer(connection, {
        channelName: row.channelName,
        channelFamily: row.channelFamily,
        payload: undefined,
        rejoining: true,
      });
    } catch (error) {
      // A config error, or a storage/internal failure, is not the gate revoking
      // access — propagate it so we never delete durable state on an infra blip.
      rethrowIfConfigError(error);
      if (!RejoinRejected.matches(error) && !ChannelNotFound.matches(error)) throw error;

      // The gate rejected (or the channel no longer exists). Drop the row
      // so the next reconnect does not retry the same dead membership, and
      // deliver an error scoped to that channel so the client knows.
      deleteMembership(runtime.sql, {
        userId: connection.userId,
        channelName: row.channelName,
        channelFamily: row.channelFamily,
      });

      let reason: string;
      if (RejoinRejected.matches(error)) reason = error.detail.message;
      else if (error instanceof Error) reason = error.message;
      else reason = String(error);

      const wskit: Record<string, unknown> = { channel: row.channelName };
      if (row.channelFamily !== null) wskit.channelFamily = row.channelFamily;

      runtime.sendProtocolMessage(connection, {
        event: '__error__',
        payload: { code: RejoinRejected.code, detail: { message: reason } },
        wskit,
      });

      runtime.logger?.error('[wskit] auto-rejoin gate rejected', {
        userId: connection.userId,
        channel: row.channelName,
        channelFamily: row.channelFamily,
        error: reason,
      });
    }
  }
}
