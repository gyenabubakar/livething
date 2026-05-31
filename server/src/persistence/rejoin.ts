import { validateValue } from '~/_engine/compile/utils.ts';
import { deleteMembership, listMembershipsByIdentity } from '~/persistence/storage.ts';
import { addConnectionTag } from '~/tags/runtime.ts';
import { listTagsByIdentity } from '~/tags/storage.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { Logger, SQLProvider } from '~/context.ts';
import type { Validator } from '~/types.ts';

export interface RejoinSubscribeOptions {
  channelName: string;

  channelScope: string | null;

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
   * for every durable membership the identity has so the connection lands
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
 * Auto-rejoin every persistent channel the connection's identity was in.
 *
 * Runs once per accept, BEFORE `onConnect` fires, so user handlers see the
 * connection already in its old channels. For each durable membership the
 * engine re-runs the `check` hook. On pass the connection is committed
 * via the server-subscribe primitive (`source: 'server'`, fires `__subscribeOk__`
 * and `__memberJoin__` syncs the same way a fresh subscribe does). On reject
 * the durable row is dropped and an `__error__` scoped to the channel is sent
 * to the new socket so the client knows that one channel did not restore.
 *
 * Rows for channels that no longer exist (renamed or removed between
 * deploys) are skipped silently — boot cleanup is where those dead rows
 * get purged.
 *
 * No-ops:
 * - Empty identity (anonymous flow with no key to look rows up by).
 * - No rows for this identity.
 *
 * @internal
 */
/**
 * Put an identity's saved persistent tags back into the live tag index.
 *
 * Runs on a fresh connect (via auto-rejoin) and on a hibernation wake, where
 * the per-connection snapshot only carries ephemeral tags. Reading by identity
 * means a tag dropped for the whole identity while this socket slept does not
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
  if (!connection.identity) return;
  for (const tag of listTagsByIdentity(sql, connection.identity)) {
    const schema = opts.getSchema?.(tag.group);
    if (schema) {
      try {
        validateValue(schema, tag.key, `tag persistent:${tag.group}`);
      } catch (error) {
        // A stored value that no longer matches the group's schema (e.g. the
        // schema tightened across a deploy). Drop it and move on rather than
        // crashing the wake/rejoin.
        opts.logger?.error('[wskit] dropped a stored persistent tag that failed validation', {
          group: tag.group,
          error: error instanceof Error ? error.message : String(error),
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
  if (!connection.identity) return;

  // Restore persistent tags first — channel auto-rejoin's check hook
  // can read them via `ctx.tags.persistent(...)`.
  restorePersistentTags({
    sql: runtime.sql,
    tagMembers: runtime.tagMembers,
    connection,
    getSchema: runtime.getTagGroupSchema,
    logger: runtime.logger,
  });

  const rows = listMembershipsByIdentity(runtime.sql, connection.identity);
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      await runtime.subscribeConnectionAsServer(connection, {
        channelName: row.channelName,
        channelScope: row.channelScope,
        payload: undefined,
        rejoining: true,
      });
    } catch (error) {
      // The gate rejected (or the channel no longer exists). Drop the row
      // so the next reconnect does not retry the same dead membership, and
      // deliver an error scoped to that channel so the client knows.
      deleteMembership(runtime.sql, {
        identity: connection.identity,
        channelName: row.channelName,
        channelScope: row.channelScope,
      });

      const wskit: Record<string, unknown> = { channel: row.channelName };
      if (row.channelScope !== null) wskit.channelScope = row.channelScope;

      runtime.sendProtocolMessage(connection, {
        event: '__error__',
        payload: {
          code: 'rejoin-rejected',
          detail: { message: error instanceof Error ? error.message : String(error) },
        },
        wskit,
      });

      runtime.logger?.error('[wskit] auto-rejoin gate rejected', {
        identity: connection.identity,
        channel: row.channelName,
        channelScope: row.channelScope,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
