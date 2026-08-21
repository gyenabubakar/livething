import { CloseCodes, WSKitConfigError } from '@wskit/core';
import type { EngineCore } from '~/_engine/core.ts';

/** Options accepted by {@link purgeUser}. */
export interface PurgeUserOptions {
  /**
   * Keep the content of broadcast streams the user created — the channel-owned
   * stream and its recorded chunks. Default `false`: that content is deleted
   * along with everything else the user owns. Either way, the user is cleared
   * as the stream's creator.
   */
  keepBroadcastContent?: boolean;
}

/**
 * "This user is gone, wipe them everywhere." Runs every registered
 * `onPurgeUser` hook — each capability that owns per-user durable rows
 * (channel membership, persistent tags, ...) cleans up its own — then closes
 * every live socket belonging to the user. With nothing registered this only
 * closes sockets and touches no storage.
 *
 * Every hook runs even when one throws, and every socket is closed even when
 * one close throws: a purge that reports "3 of 4 steps done" is far better
 * than one that silently stops at the first failure and leaves live sockets
 * open. Failures are collected and thrown together, after the socket-close
 * loop has run.
 */
export async function purgeUser(
  core: EngineCore,
  userId: string,
  options?: PurgeUserOptions,
): Promise<void> {
  if (userId === '') {
    throw new WSKitConfigError(
      "[wskit] purgeUser('') would match every anonymous connection. Pass the id of a signed-in user.",
    );
  }

  const failures: unknown[] = [];

  for (const hook of core.hooks.purgeUser) {
    try {
      await hook(core, userId, options);
    } catch (err) {
      failures.push(err);
    }
  }

  for (const connection of core.connections.values()) {
    if (connection.userId === userId) {
      try {
        connection.descriptor.close(CloseCodes.NORMAL, 'user purged');
      } catch (err) {
        failures.push(err);
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `purgeUser('${userId}') failed for ${failures.length} cleanup or socket-close step(s)`,
    );
  }
}
