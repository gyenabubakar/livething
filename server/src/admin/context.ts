import { ChannelNotFound } from '@wskit/core';
import { createLazyStorageView } from '~/_engine/contexts/lazy-storage.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

/** Deps for an admin context: the task/shutdown dep-bag plus a `purgeIdentity`. */
export interface CreateAdminContextDeps extends EngineContextTypes.CreateTaskContextDeps {
  /** Drop a user everywhere and close their sockets. Closes over the engine core. */
  purgeIdentity(identity: string): Promise<void>;
}

/** `channels.get(name)` vs `channels.get(family, instance)` → a resolve target. */
function toTarget(name: string, instance?: string): string | { family: string; name: string } {
  return instance === undefined ? name : { family: name, name: instance };
}

/**
 * Build the connectionless {@link PublicApi.AdminContext} reached with
 * `service.admin()`. Every operation acts on the whole server — there is no
 * current connection, so no `id` / `send` / `meta`. Built only from the engine's
 * runtime-agnostic dep-bag, so it carries no platform specifics.
 */
export function createAdminContext(
  deps: CreateAdminContextDeps,
): PublicApi.AdminContext<Record<string, unknown>, Record<string, unknown>, unknown> {
  const { sql, kv } = createLazyStorageView(deps.requireStorage);

  const channels: PublicApi.AdminChannels = {
    get(name: string, instance?: string): PublicApi.AdminChannelHandle {
      const resolved = deps.resolveChannel(toTarget(name, instance));
      if (!resolved) throw ChannelNotFound();
      const { channelName, channelFamily } = resolved;
      return {
        broadcast: (event, payload) =>
          deps.broadcastToChannel({
            channelName,
            channelFamily,
            event,
            payload,
            excludeConnectionId: undefined,
          }),
        members: () => deps.getChannelMembers(channelName, channelFamily),
        kick: (target, reason) =>
          deps.kickChannelMembers({ channelName, channelFamily, target, reason }),
        removeMember: (identity) => deps.removeChannelMember(channelName, channelFamily, identity),
      };
    },
  };

  function cancelScheduled(taskId: string, filter?: Record<string, unknown>): void {
    const result = deps.cancelScheduled(taskId, filter);
    if (result.removed === 0) {
      deps.logger.error('[wskit] cancelScheduled matched no runs', {
        taskId,
        filter,
        taskExists: result.taskExists,
      });
    }
  }

  return {
    broadcast: (event, payload) => {
      deps.broadcastToConnections([...deps.connections.values()], { event, payload });
    },
    channels,
    purgeIdentity: (identity) => deps.purgeIdentity(identity),
    closeConnections: (filter, code, reason) => {
      for (const connection of deps.connections.values()) {
        if (filter?.identity !== undefined && connection.identity !== filter.identity) continue;
        connection.descriptor.close(code, reason);
      }
    },
    getConnections: () =>
      [...deps.connections.values()].map((connection) => deps.toConnectionInfo(connection)),
    connectionCount: deps.connections.size,
    sql,
    kv,
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled,
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };
}
