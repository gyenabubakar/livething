import { channelRuntime } from '~/_engine/engine.deps.ts';
import { sendProtocolMessage } from '~/_engine/runtime/wire.ts';
import { autoRejoinIdentity as runAutoRejoin } from '~/channel/rejoin.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ChannelStorage from '~/channel/storage.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { MembershipKey } from '~/channel/storage.ts';
import type * as PublicApi from '~/context.ts';

type OptsParameter = {
  channelName: string;
  channelFamily: string | null;
  payload: unknown;
  rejoining?: boolean;
};

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/** Server-initiated channel subscribe. Used by the auto-rejoin path. */
type SubscribeFromServerFn = (ref: PublicApi.ConnectionRef, opts: OptsParameter) => Promise<void>;

/**
 * Write a durable channel-membership row. The caller should check
 * `isChannelDurable(...)` first.
 *
 * Skips the write for an empty user id. A durable membership row exists only
 * to auto-rejoin the same user on a future reconnect, which needs a stable
 * user id to match against. An anonymous connection (no `onUpgrade` user id)
 * has none, so the row could never be rejoined — and rejoin (`rejoin.ts`)
 * already bails on an empty user id. Writing it anyway would leak a row that
 * is never read and never cleaned. This mirrors the persistent-tag rule, which
 * also skips durable writes when there is no user id.
 */
export function persistMembership(core: EngineCore, row: ChannelStorage.MembershipInsert): void {
  if (!row.userId) return;

  ChannelStorage.insertMembership(core.storage.sql, row);
}

/**
 * Delete a durable channel-membership row. Called on a real leave (client
 * `__unsubscribe__`, a revoking `kick`) of a persistent channel. No-op for
 * an empty user id — nothing was ever written for one (see persistMembership).
 */
export function deleteDurableMembership(core: EngineCore, key: MembershipKey): void {
  if (!key.userId) return;

  ChannelStorage.deleteMembership(core.storage.sql, key);
}

/**
 * Read the durable membership row for this user and channel, or `undefined`
 * when there is none. Always `undefined` for an empty user id — anonymous
 * connections never get a row.
 */
export function getDurableMembership(
  core: EngineCore,
  key: MembershipKey,
): ChannelStorage.StoredMembership | undefined {
  if (!key.userId) return undefined;

  return ChannelStorage.readMembership(core.storage.sql, key);
}

/**
 * Mark a durable membership row as kicked: the user stays set to rejoin on
 * their next connection, but is no longer listed as a member. No-op for an
 * empty user id.
 */
export function markDurableMembershipKicked(core: EngineCore, key: MembershipKey): void {
  if (!key.userId) return;

  ChannelStorage.markMembershipKicked(core.storage.sql, key);
}

/** Read every durable member of one channel, for the member roster. */
export function listDurableMembers(
  core: EngineCore,
  channelName: string,
  channelFamily: string | null,
): (ChannelStorage.StoredMembership & { userId: string })[] {
  return ChannelStorage.listMembersByChannel(core.storage.sql, channelName, channelFamily);
}

/**
 * "This user is gone, wipe them everywhere" — the channel-membership half.
 * Kicks the user out of every channel it currently belongs to (live or
 * durable-only), then drops its durable membership rows. Registered as an
 * `onPurgeUser` hook by the `channels()` capability; `purgeUser` also closes
 * the user's live sockets, but that part is core, not channel-specific.
 */
export async function purgeChannelMembership(core: EngineCore, userId: string): Promise<void> {
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

  const sql = core.storage.sql;
  for (const row of ChannelStorage.listMembershipsByUser(sql, userId)) {
    channels.set(ChannelPrimitive.createChannelMembershipKey(row.channelName, row.channelFamily), {
      channelName: row.channelName,
      channelFamily: row.channelFamily,
    });
  }

  const target: PublicApi.UserRef = {
    __livething: 'user-ref',
    id: userId,
    instance: core.engineInstanceId,
  };

  // A leave hook that throws must not stop the purge: every channel is left and
  // every row dropped before the failures are reported.
  const failures: unknown[] = [];
  for (const { channelName, channelFamily } of channels.values()) {
    try {
      await core.channelService?.kickChannelMembers(core, {
        channelName,
        channelFamily,
        target,
        reason: 'user purged',
        revoke: true,
      });
    } catch (error) {
      failures.push(error);
    }
  }

  ChannelStorage.purgeMembershipsByUser(sql, userId);

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `[livething] leaving ${failures.length} channel(s) failed while purging a user`,
    );
  }
}

/**
 * Re-join every durable channel the user had before. Called from
 * `acceptConnection` between the connection-row write and `onConnect`.
 * No-op when the user has no stored rows.
 */
export async function autoRejoinIdentity(
  core: EngineCore,
  subscribeFromServer: SubscribeFromServerFn,
  connection: RuntimeConnection,
): Promise<void> {
  const sql = core.storage.sql;
  await runAutoRejoin(
    {
      sql,
      subscribeConnectionAsServer: async (target, opts) => {
        const ref: PublicApi.ConnectionRef = {
          __livething: 'connection-ref',
          id: target.id,
          instance: core.engineInstanceId,
          userId: target.userId,
        };

        return subscribeFromServer(ref, opts);
      },
      sendProtocolMessage: (target, opts) => sendProtocolMessage(core, target, opts),
      removeStoredMember: (userId, channelName, channelFamily) =>
        ChannelPrimitive.removeStoredMember(channelRuntime(core), {
          userId,
          channelName,
          channelFamily,
          revoke: true,
        }),
      logger: core.logger,
    },
    connection,
  );
}
