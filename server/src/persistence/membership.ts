import { CloseCodes } from '@wskit/core';
import { sendProtocolMessage } from '~/_engine/runtime/wire.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { autoRejoinIdentity as runAutoRejoin } from '~/persistence/rejoin.ts';
import * as PersistenceStorage from '~/persistence/storage.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type { MembershipKey } from '~/persistence/storage.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/** Server-initiated channel subscribe. Used by the auto-rejoin path. */
type SubscribeFromServerFn = (
  ref: PublicApi.ConnectionRef,
  opts: {
    channelName: string;
    channelFamily: string | null;
    payload: unknown;
    rejoining?: boolean;
  },
) => Promise<void>;

/**
 * Write a durable channel-membership row. The caller should check
 * `isChannelPersistent(...)` first — we still gate on `persistenceEnabled`
 * here as a safety net.
 *
 * Skips the write for an empty user id. A durable membership row exists only
 * to auto-rejoin the same user on a future reconnect, which needs a stable
 * user id to match against. An anonymous connection (no `onUpgrade` user id)
 * has none, so the row could never be rejoined — and rejoin (`rejoin.ts`)
 * already bails on an empty user id. Writing it anyway would leak a row that
 * is never read and never cleaned. This mirrors the persistent-tag rule, which
 * also skips durable writes when there is no user id.
 */
export function persistMembership(core: EngineCore, key: MembershipKey): void {
  if (!core.persistenceEnabled) return;
  if (!key.userId) return;
  PersistenceStorage.insertMembership(core.requireStorage().sql, key);
}

/**
 * Delete a durable channel-membership row. Called on a real leave (client
 * `__unsubscribe__`, a revoking `kick`) of a persistent channel. No-op for
 * an empty user id — nothing was ever written for one (see persistMembership).
 */
export function deleteDurableMembership(core: EngineCore, key: MembershipKey): void {
  if (!core.persistenceEnabled) return;
  if (!key.userId) return;
  PersistenceStorage.deleteMembership(core.requireStorage().sql, key);
}

/**
 * True when a durable membership row exists for this user and channel.
 * Always false for an empty user id — anonymous connections never get a row.
 */
export function hasDurableMembership(core: EngineCore, key: MembershipKey): boolean {
  if (!core.persistenceEnabled) return false;
  if (!key.userId) return false;
  return PersistenceStorage.membershipExists(core.requireStorage().sql, key);
}

/**
 * "This user is gone, wipe them everywhere". Drops every persistent
 * membership and persistent tag for `userId`, then closes every live
 * socket. Backs the future `admin().purgeUser()` surface.
 */
export async function purgeUser(core: EngineCore, userId: string): Promise<void> {
  // Dedup the channels by membership key; the pair itself is the map value,
  // so the key stays opaque and is never parsed back.
  const channels = new Map<string, { channelName: string; channelFamily: string | null }>();

  for (const connection of core.connections.values()) {
    if (connection.userId !== userId) continue;
    for (const membership of connection.channelMemberships.values()) {
      channels.set(
        ChannelPrimitive.createChannelMembershipKey(
          membership.channelName,
          membership.channelFamily,
        ),
        membership,
      );
    }
  }

  if (core.persistenceEnabled) {
    const sql = core.requireStorage().sql;
    const rows = PersistenceStorage.listMembershipsByUser(sql, userId);
    for (const row of rows) {
      channels.set(
        ChannelPrimitive.createChannelMembershipKey(row.channelName, row.channelFamily),
        {
          channelName: row.channelName,
          channelFamily: row.channelFamily,
        },
      );
    }
  }

  const target: PublicApi.UserRef = {
    __wskit: 'user-ref',
    id: userId,
    instance: core.engineInstanceId,
  };
  for (const { channelName, channelFamily } of channels.values()) {
    await core.channelService?.kickChannelMembers(core, {
      channelName,
      channelFamily,
      target,
      reason: 'user purged',
      revoke: true,
    });
  }

  if (core.persistenceEnabled) {
    const sql = core.requireStorage().sql;
    PersistenceStorage.purgeMembershipsByUser(sql, userId);
    PersistenceStorage.purgeTagsByUser(sql, userId);
  }

  for (const connection of core.connections.values()) {
    if (connection.userId === userId) {
      connection.descriptor.close(CloseCodes.NORMAL, 'user purged');
    }
  }
}

/**
 * Re-join every durable channel the user had before. Called from
 * `acceptConnection` between the connection-row write and `onConnect`.
 * No-op when persistence is off or the user has no stored rows.
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
      subscribeConnectionAsServer: async (target, opts) => {
        const ref: PublicApi.ConnectionRef = {
          __wskit: 'connection-ref',
          id: target.id,
          instance: core.engineInstanceId,
          userId: target.userId,
        };
        return subscribeFromServer(ref, opts);
      },
      sendProtocolMessage: (target, opts) => sendProtocolMessage(core, target, opts),
      getTagGroupSchema: (group) => core.getTagGroupSchema('persistent', group),
      logger: core.logger,
    },
    connection,
  );
}
