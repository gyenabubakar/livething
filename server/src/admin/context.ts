import { ChannelNotFound } from '@wskit/core';
import { buildConnectionsManager, buildUsersManager } from '~/_engine/contexts/contexts.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

/** Deps for an admin context: the task/shutdown dep-bag plus a `purgeUser`. */
export interface CreateAdminContextDeps extends EngineContextTypes.CreateTaskContextDeps {
  /** Drop a user everywhere and close their sockets. Closes over the engine core. */
  purgeUser(userId: string): Promise<void>;
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
  const { sql, kv } = deps.getStorageView();

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
        kick: (target, opts) =>
          deps.kickChannelMembers({
            channelName,
            channelFamily,
            target,
            reason: opts.reason,
            revoke: opts.revoke,
          }),
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
      deps.broadcastToConnections(deps.connections.values(), { event, payload });
    },
    channels,
    purgeUser: (userId) => deps.purgeUser(userId),
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
    cancelScheduled,
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };
}

/**
 * Every member name the admin context itself owns, as a tuple so a name that is
 * not a real member fails to compile. `Engine.admin()` merges the
 * app's `api` into that context, so an adapter tells the two apart by name: a
 * key outside this set came from the dev's `api` factory.
 *
 * Adapters that expose admin over a transport (rather than in-process) need the
 * distinction to know what to forward — see the Cloudflare adapter, where only
 * the app's own methods are promoted onto the RPC target.
 */
export const ADMIN_CONTEXT_MEMBER_NAMES = [
  'broadcast',
  'channels',
  'purgeUser',
  'closeConnections',
  'connections',
  'users',
  'connectionCount',
  'sql',
  'kv',
  'schedule',
  'cancelScheduled',
  'env',
  'log',
  'waitUntil',
  'platform',
] as const satisfies readonly AdminContextMember[];

/** A member name of the admin context. */
export type AdminContextMember = keyof PublicApi.AdminContext<
  Record<string, unknown>,
  Record<string, unknown>,
  unknown
>;

/** Any admin-context member {@link ADMIN_CONTEXT_MEMBER_NAMES} forgot to list. */
export type UnlistedAdminContextMember = Exclude<
  AdminContextMember,
  (typeof ADMIN_CONTEXT_MEMBER_NAMES)[number]
>;

/** @see ADMIN_CONTEXT_MEMBER_NAMES */
export const ADMIN_CONTEXT_MEMBERS: ReadonlySet<string> = new Set(ADMIN_CONTEXT_MEMBER_NAMES);
