import { buildConnectionsManager, buildUsersManager } from '~/_engine/contexts/contexts.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

/**
 * Build the context passed to scheduled tasks and plugin-owned scheduled work.
 */
export function createTaskContext(
  deps: EngineContextTypes.CreateTaskContextDeps,
): PublicApi.TaskContext<Record<string, unknown>, unknown> {
  const { sql, kv } = deps.getStorageView();
  const ctx: PublicApi.TaskContext<Record<string, unknown>, unknown> = {
    sql,
    kv,
    broadcast: (event, payload) => {
      deps.broadcastToConnections([...deps.connections.values()], { event, payload });
    },
    connections: buildConnectionsManager(deps),
    users: buildUsersManager(deps),
    get connectionCount() {
      return deps.connections.size;
    },
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled: (taskId, filter) => {
      const result = deps.cancelScheduled(taskId, filter);
      if (result.removed === 0) {
        deps.logger.error('[wskit] cancelScheduled matched no runs', {
          taskId,
          filter,
          taskExists: result.taskExists,
        });
      }
    },
    log: deps.logger,
    platform: deps.platform,
  };

  return ctx;
}
