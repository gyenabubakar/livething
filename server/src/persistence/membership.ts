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
 * Skips the write for an empty identity. A durable membership row exists only
 * to auto-rejoin the same identity on a future reconnect, which needs a stable
 * identity to match against. An anonymous connection (no `onUpgrade` identity)
 * has none, so the row could never be rejoined — and rejoin (`rejoin.ts`)
 * already bails on an empty identity. Writing it anyway would leak a row that
 * is never read and never cleaned. This mirrors the persistent-tag rule, which
 * also skips durable writes when there is no identity.
 */
export function persistMembership(core: EngineCore, key: MembershipKey): void {
  if (!core.persistenceEnabled) return;
  if (!key.identity) return;
  PersistenceStorage.insertMembership(core.requireStorage().sql, key);
}

/**
 * Delete a durable channel-membership row. Called on a real leave (client
 * `__unsubscribe__`, `removeMember`, kick) of a persistent channel. No-op for
 * an empty identity — nothing was ever written for one (see persistMembership).
 */
export function deleteDurableMembership(core: EngineCore, key: MembershipKey): void {
  if (!core.persistenceEnabled) return;
  if (!key.identity) return;
  PersistenceStorage.deleteMembership(core.requireStorage().sql, key);
}

/**
 * True when a durable membership row exists for this identity and channel.
 * Always false for an empty identity — anonymous connections never get a row.
 */
export function hasDurableMembership(core: EngineCore, key: MembershipKey): boolean {
  if (!core.persistenceEnabled) return false;
  if (!key.identity) return false;
  return PersistenceStorage.membershipExists(core.requireStorage().sql, key);
}

/**
 * "This user is gone, wipe them everywhere". Drops every persistent
 * membership and persistent tag for `identity`, then closes every live
 * socket. Backs the future `admin().purgeIdentity()` surface.
 */
export async function purgeIdentity(core: EngineCore, identity: string): Promise<void> {
  // Dedup the channels by membership key; the pair itself is the map value,
  // so the key stays opaque and is never parsed back.
  const channels = new Map<string, { channelName: string; channelFamily: string | null }>();

  for (const connection of core.connections.values()) {
    if (connection.identity !== identity) continue;
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
    const rows = PersistenceStorage.listMembershipsByIdentity(sql, identity);
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

  for (const { channelName, channelFamily } of channels.values()) {
    await core.channelService?.removeChannelMember(core, { channelName, channelFamily, identity });
  }

  if (core.persistenceEnabled) {
    const sql = core.requireStorage().sql;
    PersistenceStorage.purgeMembershipsByIdentity(sql, identity);
    PersistenceStorage.purgeTagsByIdentity(sql, identity);
  }

  for (const connection of core.connections.values()) {
    if (connection.identity === identity) {
      connection.descriptor.close(CloseCodes.NORMAL, 'identity purged');
    }
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
      subscribeConnectionAsServer: async (target, opts) => {
        const ref: PublicApi.ConnectionRef = {
          __wskit: 'connection-ref',
          id: target.id,
          instance: core.engineInstanceId,
          identity: target.identity,
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
