import { createLazyStorageView } from '~/_engine/contexts/lazy-storage.ts';
import { buildConnectionHandle } from '~/_engine/runtime/refs.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

/**
 * Build the context passed to scheduled tasks and plugin-owned scheduled work.
 */
export function createTaskContext(
  deps: EngineContextTypes.CreateTaskContextDeps,
): PublicApi.TaskContext<Record<string, unknown>, Record<string, unknown>, unknown> {
  const { sql, kv } = createLazyStorageView(deps.requireStorage);
  const ctx: PublicApi.TaskContext<Record<string, unknown>, Record<string, unknown>, unknown> = {
    sql,
    kv,
    broadcast: (event, payload) => {
      deps.broadcastToConnections([...deps.connections.values()], { event, payload });
    },
    ...buildConnectionHandle(deps),
    getConnections: () => {
      return [...deps.connections.values()].map((connection) => deps.toConnectionInfo(connection));
    },
    connectionCount: deps.connections.size,
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
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };

  return ctx;
}
