import { deleteMembership, listMembershipsByIdentity } from '~/persistence/storage.ts';
import { listTagsByIdentity } from '~/tags/storage.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';

/**
 * Dependency bag for the auto-rejoin path. Mirrors the channel runtime bag
 * but adds the storage handle and the server-subscribe primitive entry point
 * so the rejoin runs without re-importing the engine.
 */
export interface RejoinRuntime {
  sql: Pick<SQLProvider, 'exec'>;
  /**
   * Server-side subscribe primitive (from #11). The rejoin path invokes this
   * for every durable membership the identity has so the connection lands
   * back in the channel without a client `_subscribe` frame. The `rejoining`
   * flag tells the subscribe flow to suppress `_memberJoin` peer broadcasts
   * (the user is already a member of the group — only the new socket's
   * presence has changed).
   */
  subscribeConnectionAsServer(
    connection: EngineRuntimeTypes.RuntimeConnection,
    channelName: string,
    channelScope: string | null,
    payload: unknown,
    rejoining: boolean,
  ): Promise<void>;
  /**
   * Send a protocol-level frame addressed to the rejoining connection. Used
   * to deliver an `_error` when the gate rejects a stored membership.
   */
  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void;
  logger?: { error(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Auto-rejoin every persistent channel the connection's identity was in.
 *
 * Runs once per accept, BEFORE `onConnect` fires, so user handlers see the
 * connection already in its old channels. For each durable membership the
 * engine re-runs `onBeforeSubscribe`. On pass the connection is committed
 * via the server-subscribe primitive (`source: 'server'`, fires `_subscribeOk`
 * and `_memberJoin` syncs the same way a fresh subscribe does). On reject
 * the durable row is dropped and an `_error` scoped to the channel is sent
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
export async function autoRejoinIdentity(
  runtime: RejoinRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
): Promise<void> {
  if (!connection.identity) return;

  // Restore persistent tags first — channel auto-rejoin's onBeforeSubscribe
  // can read them via `ctx.tags.persistent(...)`.
  const tagRows = listTagsByIdentity(runtime.sql, connection.identity);
  for (const tag of tagRows) {
    const set = connection.tags.persistent.get(tag.group) ?? new Set<string>();
    set.add(tag.key);
    connection.tags.persistent.set(tag.group, set);
  }

  const rows = listMembershipsByIdentity(runtime.sql, connection.identity);
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      await runtime.subscribeConnectionAsServer(
        connection,
        row.channelName,
        row.channelScope,
        undefined,
        true,
      );
    } catch (error) {
      // The gate rejected (or the channel no longer exists). Drop the row
      // so the next reconnect does not retry the same dead membership, and
      // deliver an error scoped to that channel so the client knows.
      deleteMembership(runtime.sql, connection.identity, row.channelName, row.channelScope);

      const routing: Record<string, unknown> = { _channel: row.channelName };
      if (row.channelScope !== null) routing._channelScope = row.channelScope;
      runtime.sendProtocolMessage(connection, '_error', {
        ...routing,
        code: 'rejoin-rejected',
        message: error instanceof Error ? error.message : String(error),
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
