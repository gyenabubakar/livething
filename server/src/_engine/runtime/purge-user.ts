import { CloseCodes, LiveThingConfigError } from '@livething/core';
import type { EngineCore } from '~/_engine/core.ts';

/** Options accepted by {@link purgeUser}. */
export interface PurgeUserOptions {
  /**
   * Keep the content of broadcast streams the user created — the channel-owned
   * stream and its recorded chunks. Default `false`: that content is deleted
   * along with everything else the user owns. Either way, a stream still running
   * stops, and the user is cleared as the stream's creator.
   */
  keepBroadcastContent?: boolean;
}

/**
 * "This user is gone, wipe them everywhere." Stops the user first: their open
 * sockets take no more frames, a subscribe waiting in `check` ends with no
 * membership, and nothing writes a new durable row for them while the purge
 * runs. A handler or task already running when the purge starts stays barred
 * from writing that user's membership, replay, tag, inbox or last-seen rows
 * after the purge ends too (see `EngineCore.isUserPurging`); work that starts
 * after the purge, such as the same user id signing in again, may write.
 * Then runs every registered `onPurgeUser` hook — each capability that
 * owns per-user durable rows (channel membership, persistent tags, ...) cleans
 * up its own — and closes every live socket belonging to the user. With nothing
 * registered this only closes sockets and touches no storage.
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
    throw new LiveThingConfigError(
      "purgeUser('') would match every anonymous connection. Pass the id of a signed-in user.",
    );
  }

  const failures: unknown[] = [];

  core.markUserPurging(userId);
  for (const connection of core.connections.values()) {
    if (connection.userId === userId) {
      connection.closing = true;
      connection.purged = true;
    }
  }

  for (const hook of core.hooks.purgeUser) {
    try {
      await hook(core, userId, options);
    } catch (err) {
      failures.push(err);
    }
  }

  for (const connection of core.connections.values()) {
    if (connection.userId === userId) {
      connection.closing = true;
      connection.purged = true;
      try {
        connection.descriptor.close(CloseCodes.NORMAL, 'user purged');
      } catch (err) {
        failures.push(err);
      }
    }
  }

  core.unmarkUserPurging(userId);

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `purgeUser('${userId}') failed for ${failures.length} cleanup or socket-close step(s)`,
    );
  }
}
