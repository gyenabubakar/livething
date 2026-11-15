import { ChannelNotFound, RejoinRejected, rethrowIfConfigError } from '@livething/core';
import { deleteMembership, listMembershipsByUser } from '~/channel/storage.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { Logger, SQLProvider } from '~/context.ts';

interface RejoinSubscribeOptions {
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

  /**
   * Server-side subscribe primitive (from #11). The rejoin path invokes this
   * for every durable membership the user has so the connection lands
   * back in the channel without a client `__subscribe__` frame. The `rejoining`
   * flag tells the subscribe flow to run `revalidate` instead of the subscribe
   * gates.
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

  /**
   * End a stored membership whose `revalidate` gate rejected the rejoin: drop
   * the row and tell peers the member left. Keeps the row while another
   * connection of the user is live in the channel.
   */
  removeStoredMember(userId: string, channelName: string, channelFamily: string | null): void;

  logger?: Pick<Logger, 'error'>;
}

/**
 * Auto-rejoin every persistent channel the connection's user was in.
 *
 * Runs once per accept, BEFORE `onConnect` fires, so user handlers see the
 * connection already in its old channels. For each durable membership the
 * engine re-runs the `revalidate` hook. On pass the connection is committed
 * via the server-subscribe primitive (`source: 'server'`), which sends
 * `__subscribeOk__` to the rejoining socket. Peers see an `online` change. On
 * reject a `rejoin-rejected` `__error__` scoped to the channel is sent to the
 * new socket so the client knows that one channel did not restore. When no
 * other connection of the user is in the channel, the durable row is also
 * dropped and peers see a `leave` change.
 *
 * A row for a channel that no longer exists (renamed or removed between
 * deploys) is deleted, and the new socket gets the same `rejoin-rejected`
 * `__error__` scoped to that channel. Peers get no `leave` change, since
 * nobody can be in a channel that does not exist.
 *
 * No-ops:
 * - Empty user id (anonymous flow with no key to look rows up by).
 * - No rows for this user.
 *
 * @internal
 */
export async function autoRejoinIdentity(
  runtime: RejoinRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
): Promise<void> {
  if (!connection.userId) return;

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
      if (RejoinRejected.matches(error)) {
        runtime.removeStoredMember(connection.userId, row.channelName, row.channelFamily);
      } else {
        deleteMembership(runtime.sql, {
          userId: connection.userId,
          channelName: row.channelName,
          channelFamily: row.channelFamily,
        });
      }

      let reason: string;
      if (RejoinRejected.matches(error)) reason = error.detail.message;
      else if (error instanceof Error) reason = error.message;
      else reason = String(error);

      const livething: Record<string, unknown> = { channel: row.channelName };
      if (row.channelFamily !== null) livething.channelFamily = row.channelFamily;

      runtime.sendProtocolMessage(connection, {
        event: '__error__',
        payload: { code: RejoinRejected.code, detail: { message: reason } },
        livething,
      });

      runtime.logger?.error('[livething] auto-rejoin gate rejected', {
        userId: connection.userId,
        channel: row.channelName,
        channelFamily: row.channelFamily,
        error: reason,
      });
    }
  }
}
