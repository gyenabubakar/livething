import { sendProtocolMessage } from '~/_engine/runtime/wire.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { autoRejoinIdentity as runAutoRejoin } from '~/persistence/rejoin.ts';
import * as PersistenceStorage from '~/persistence/storage.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type CompiledChannel = EngineCompileTypes.CompiledChannel;

/**
 * Standard leave-channel flow (unsubscribe hooks, peer broadcast, durable
 * cleanup). Supplied by the caller so this file doesn't need to pull in the
 * dispatch runtime.
 */
type LeaveChannelFn = (
  connection: RuntimeConnection,
  scope: { channel?: CompiledChannel; channelName: string; channelScope: string | null },
  kickedReason?: string,
  disconnect?: boolean,
) => Promise<void>;

/** Server-initiated channel subscribe. Used by the auto-rejoin path. */
type SubscribeFromServerFn = (
  ref: PublicApi.ConnectionRef,
  channelName: string,
  channelScope: string | null,
  payload: unknown,
  rejoining?: boolean,
) => Promise<void>;

/**
 * Write a durable channel-membership row. The caller should check
 * `isChannelPersistent(...)` first — we still gate on `persistenceEnabled`
 * here as a safety net.
 */
export function persistMembership(
  core: EngineCore,
  identity: string,
  channelName: string,
  channelScope: string | null,
): void {
  if (!core.persistenceEnabled) return;
  PersistenceStorage.insertMembership(
    core.requireStorage().sql,
    identity,
    channelName,
    channelScope,
  );
}

/**
 * Delete a durable channel-membership row. Called on a real leave (client
 * `__unsubscribe__`, `removeMember`, kick) of a persistent channel.
 */
export function deleteDurableMembership(
  core: EngineCore,
  identity: string,
  channelName: string,
  channelScope: string | null,
): void {
  if (!core.persistenceEnabled) return;
  PersistenceStorage.deleteMembership(
    core.requireStorage().sql,
    identity,
    channelName,
    channelScope,
  );
}

/** True when a durable membership row exists for this identity and channel scope. */
export function hasDurableMembership(
  core: EngineCore,
  identity: string,
  channelName: string,
  channelScope: string | null,
): boolean {
  if (!core.persistenceEnabled) return false;
  return PersistenceStorage.membershipExists(
    core.requireStorage().sql,
    identity,
    channelName,
    channelScope,
  );
}

/**
 * Kick every live connection of `identity` out of one channel scope AND drop
 * the durable row. True leave: `onUnsubscribe` fires, peers get
 * `__memberLeave__`/`__memberOffline__`, and the user will NOT auto-rejoin on the
 * next reconnect. No-op if nothing matches and persistence is off.
 */
export async function removeChannelMember(
  core: EngineCore,
  leaveChannel: LeaveChannelFn,
  channelName: string,
  channelScope: string | null,
  identity: string,
): Promise<void> {
  const membershipKey = ChannelPrimitive.createChannelMembershipKey(channelName, channelScope);

  await core.channelLock.run(membershipKey, async () => {
    if (core.persistenceEnabled) {
      PersistenceStorage.deleteMembership(
        core.requireStorage().sql,
        identity,
        channelName,
        channelScope,
      );
    }

    const resolved = ChannelPrimitive.resolveCompiledChannel(
      core.compiled,
      channelName,
      channelScope,
    );

    const targets: RuntimeConnection[] = [];
    for (const connection of core.connections.values()) {
      if (connection.identity !== identity) continue;
      if (!connection.channelMemberships.has(membershipKey)) continue;
      targets.push(connection);
    }

    for (const connection of targets) {
      try {
        await leaveChannel(connection, {
          channel: resolved,
          channelName,
          channelScope,
        });
      } catch (error) {
        core.logger.error('[wskit] removeChannelMember leaveChannel threw', {
          identity,
          channel: channelName,
          channelScope,
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
}

/**
 * "This user is gone, wipe them everywhere". Drops every persistent
 * membership and persistent tag for `identity`, then closes every live
 * socket. Backs the future `admin().purgeIdentity()` surface.
 */
export async function purgeIdentity(
  core: EngineCore,
  leaveChannel: LeaveChannelFn,
  identity: string,
): Promise<void> {
  // Dedup the channels by membership key; the pair itself is the map value,
  // so the key stays opaque and is never parsed back.
  const channels = new Map<string, { channelName: string; channelScope: string | null }>();

  for (const connection of core.connections.values()) {
    if (connection.identity !== identity) continue;
    for (const membership of connection.channelMemberships.values()) {
      channels.set(
        ChannelPrimitive.createChannelMembershipKey(
          membership.channelName,
          membership.channelScope,
        ),
        membership,
      );
    }
  }

  if (core.persistenceEnabled) {
    const sql = core.requireStorage().sql;
    const rows = PersistenceStorage.listMembershipsByIdentity(sql, identity);
    for (const row of rows) {
      channels.set(ChannelPrimitive.createChannelMembershipKey(row.channelName, row.channelScope), {
        channelName: row.channelName,
        channelScope: row.channelScope,
      });
    }
  }

  for (const { channelName, channelScope } of channels.values()) {
    await removeChannelMember(core, leaveChannel, channelName, channelScope, identity);
  }

  if (core.persistenceEnabled) {
    const sql = core.requireStorage().sql;
    PersistenceStorage.purgeMembershipsByIdentity(sql, identity);
    PersistenceStorage.purgeTagsByIdentity(sql, identity);
  }
}

/**
 * Re-join every durable channel the identity had before. Called from
 * `acceptConnection` between the connection-row write and `onConnect`.
 * No-op when persistence is off or the identity has no stored rows.
 */
export async function autoRejoinIdentity(
  core: EngineCore,
  subscribeFromServer: SubscribeFromServerFn,
  connection: RuntimeConnection,
): Promise<void> {
  if (!core.persistenceEnabled) return;
  const sql = core.requireStorage().sql;
  await runAutoRejoin(
    {
      sql,
      tagMembers: core.tagMembers,
      subscribeConnectionAsServer: async (
        target,
        channelName,
        channelScope,
        payload,
        rejoining,
      ) => {
        const ref: PublicApi.ConnectionRef = {
          __wskit: 'connection-ref',
          id: target.id,
          instance: core.engineInstanceId,
          identity: target.identity,
        };
        return subscribeFromServer(ref, channelName, channelScope, payload, rejoining);
      },
      sendProtocolMessage: (target, event, payload, wskit) =>
        sendProtocolMessage(core, target, event, payload, wskit),
      logger: core.logger,
    },
    connection,
  );
}
