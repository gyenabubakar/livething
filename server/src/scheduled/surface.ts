import { registerScheduledService } from '~/_engine/scheduling.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { Primitive } from '~/primitive.ts';

/** Unique key so the schedule surface installs once however many tasks are listed. */
const SCHEDULE_SURFACE_KEY = Symbol('scheduled-surface');

/**
 * Build the `ctx.schedule` / `ctx.cancelScheduled` surface for a connection
 * context. Owned by the `scheduled()` capability so a server that only has an
 * internally-built scheduled primitive (a stream-sweep sweep, say) never gets it.
 */
function buildScheduleSurface(engine: EngineAccess): Record<string, unknown> {
  return {
    schedule: (taskId: string, options: { time: number; data?: unknown }) => {
      engine.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled: (taskId: string, filter?: Record<string, unknown>) => {
      const result = engine.cancelScheduled(taskId, filter);
      if (result.removed === 0) {
        engine.getLogger?.()?.error('[wskit] cancelScheduled matched no runs', {
          taskId,
          filter,
          taskExists: result.taskExists,
        });
      }
    },
  };
}

/**
 * The primitive the `scheduled()` capability contributes to install the
 * `ctx.schedule` / `ctx.cancelScheduled` surface. Keyed so listing many tasks
 * still installs the extender once.
 *
 * @internal
 */
export function scheduleSurfacePrimitive(): Primitive {
  return {
    __wskit: 'scheduledSurface',
    __kind: 'infrastructure',
    __identity: [SCHEDULE_SURFACE_KEY],
    __requires: {},
    __setup(engine) {
      registerScheduledService(engine);
      engine.installOnce(SCHEDULE_SURFACE_KEY, () => {
        engine.extendContext(() => buildScheduleSurface(engine));
      });
    },
  };
}
