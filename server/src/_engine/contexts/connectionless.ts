import { ChannelNotFound } from '@livething/core';
import { buildConnectionsManager, buildUsersManager } from '~/_engine/contexts/contexts.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

/**
 * `channels.get(name)`, `channels.get(family, instance)`, or a channel
 * declaration or `.at(params)` ref → a resolve target. Same rules as the
 * connection ctx's `channels.get`.
 */
function toTarget(name: unknown, instance?: string): string | { family: string; name: string } {
  if (instance !== undefined) return { family: name as string, name: instance };

  if (name && typeof name === 'object') {
    if ('__livethingChannelRef' in name) {
      const ref = name as unknown as { family: string; name: string };
      return { family: ref.family, name: ref.name };
    }

    if ('__livethingChannel' in name) return (name as unknown as { __key: string }).__key;
  }

  return name as string;
}

/**
 * Build the {@link PublicApi.ConnectionlessContext} that `onShutdown` hooks,
 * scheduled task bodies and the admin surface all receive. Every operation acts
 * on the whole server — there is no current connection, so no `send` / `meta`.
 * Built only from the engine's runtime-agnostic dep-bag, so it carries no
 * platform specifics.
 */
export function createConnectionlessContext(
  deps: EngineContextTypes.CreateConnectionlessContextDeps,
): PublicApi.ConnectionlessContext<Record<string, unknown>, unknown> {
  const { sql, kv } = deps.getStorageView();

  const channels: PublicApi.ConnectionlessChannels = {
    get(name: unknown, instance?: string): PublicApi.ConnectionlessChannelHandle {
      const resolved = deps.resolveChannel(toTarget(name, instance));
      if (!resolved) throw ChannelNotFound();

      const { channelName, channelFamily } = resolved;
      const handle: PublicApi.ConnectionlessChannelHandle = {
        broadcast: (event, payload) =>
          deps.broadcastToChannel({
            channelName,
            channelFamily,
            event,
            payload,
            excludeConnectionId: undefined,
          }),
        members: () => deps.getChannelMembers(channelName, channelFamily),
        kick: (target, opts) =>
          deps.kickChannelMembers({
            channelName,
            channelFamily,
            target,
            reason: opts.reason,
          }),
      };

      deps.addBinarySenders?.(handle, { broadcast: 'event-first' });

      return handle;
    },
    broadcast(channel, event, payload) {
      const handle =
        typeof channel === 'string'
          ? channels.get(channel)
          : channels.get(channel.family, channel.name);
      handle.broadcast(event, payload);
    },
  };

  deps.addBinarySenders?.(channels, { broadcast: 'event-second' });

  const ctx: PublicApi.ConnectionlessContext<Record<string, unknown>, unknown> = {
    broadcast: (event, payload) => {
      deps.broadcastToConnections(deps.connections.values(), { event, payload });
    },
    channels,
    purgeUser: (userId, options) =>
      options === undefined ? deps.purgeUser(userId) : deps.purgeUser(userId, options),
    closeConnections: (filter, code, reason) => {
      for (const connection of deps.connections.values()) {
        if (filter?.userId !== undefined && connection.userId !== filter.userId) continue;

        connection.descriptor.close(code, reason);
      }
    },
    connections: buildConnectionsManager(deps),
    users: buildUsersManager(deps),
    get connectionCount() {
      return deps.connections.size;
    },
    sql,
    kv,
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled: (taskId, filter) => {
      deps.cancelScheduled(taskId, filter);
    },
    log: deps.logger,
    platform: deps.platform,
  };

  deps.addBinarySenders?.(ctx, { broadcast: 'event-first' });

  return ctx;
}
