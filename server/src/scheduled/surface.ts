import { registerScheduledService } from '~/_engine/scheduling.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { Primitive } from '~/primitive.ts';

type BuildScheduleSurfaceOptionsParameter = { time: number; data?: unknown };

/** Unique key so the schedule surface installs once however many tasks are listed. */
const SCHEDULE_SURFACE_KEY = Symbol('scheduled-surface');

/**
 * Build the `ctx.schedule` / `ctx.cancelScheduled` surface for a connection
 * context. Owned by the `scheduled()` capability so a server that only has an
 * internally built scheduled primitive (such as a stream sweep) never gets it.
 */
function buildScheduleSurface(engine: EngineAccess): Record<string, unknown> {
  return {
    schedule: (taskId: string, options: BuildScheduleSurfaceOptionsParameter) => {
      engine.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled: (taskId: string, filter?: Record<string, unknown>) => {
      engine.cancelScheduled(taskId, filter);
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
    __livething: 'scheduledSurface',
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
