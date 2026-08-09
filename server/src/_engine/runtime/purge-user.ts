import { CloseCodes } from '@wskit/core';
import type { EngineCore } from '~/_engine/core.ts';

/**
 * "This user is gone, wipe them everywhere." Runs every registered
 * `onPurgeUser` hook — each capability that owns per-user durable rows
 * (channel membership, persistent tags, ...) cleans up its own — then closes
 * every live socket belonging to the user. With nothing registered this only
 * closes sockets and touches no storage.
 */
export async function purgeUser(core: EngineCore, userId: string): Promise<void> {
  for (const hook of core.hooks.purgeUser) {
    await hook(core, userId);
  }

  for (const connection of core.connections.values()) {
    if (connection.userId === userId) {
      connection.descriptor.close(CloseCodes.NORMAL, 'user purged');
    }
  }
}
