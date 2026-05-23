import * as Scheduled from '~/scheduled/runtime.ts';
import { SCHEDULED_RUNTIME_KEY } from '~/scheduled/scheduled.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';

/** Build the access object the scheduled runtime needs from core + task-context factory. */
function buildAccess(
  core: EngineCore,
  createTaskContext: () => unknown,
): ScheduledPrimitiveTypes.ScheduledRuntimeAccess {
  return {
    requireStorage: () => core.requireStorage(),
    requireTimers: () => core.requireTimers(),
    generateId: (prefix) => core.generateId(prefix),
    getScheduledRuns: () => core.scheduledRuns,
    getScheduledDlq: () => core.scheduledDlq,
    getScheduledTask: (taskId) => core.compiled.scheduled.get(taskId),
    getScheduledTasks: () => core.compiled.scheduled.values(),
    createTaskContext,
    rescheduleAlarm: () => rescheduleAlarm(core),
  };
}

/**
 * Install the scheduled runtime on first use (idempotent). Adds a schema-init
 * hook for the tables, a boot hook that loads the queue, and an alarm hook
 * that drains due runs.
 */
export function ensureScheduledRuntime(core: EngineCore, createTaskContext: () => unknown): void {
  if (core.installedFeatures.has(SCHEDULED_RUNTIME_KEY)) return;
  core.installedFeatures.add(SCHEDULED_RUNTIME_KEY);

  core.hooks.bootSchema.push(() =>
    Scheduled.ensureScheduledSchema(buildAccess(core, createTaskContext)),
  );
  core.hooks.boot.push(() =>
    Scheduled.bootstrapScheduledRuntime(buildAccess(core, createTaskContext)),
  );
  core.hooks.alarm.push(async () =>
    Scheduled.handleScheduledAlarm(buildAccess(core, createTaskContext)),
  );
}

/** Queue one future scheduled task run. */
export function scheduleTask(
  core: EngineCore,
  createTaskContext: () => unknown,
  taskId: string,
  time: number,
  data: unknown,
): void {
  Scheduled.scheduleTaskRun(buildAccess(core, createTaskContext), taskId, time, data);
}

/** Remove every queued run for one scheduled task id. */
export function cancelScheduled(
  core: EngineCore,
  createTaskContext: () => unknown,
  taskId: string,
  filter?: Record<string, unknown>,
): ScheduledPrimitiveTypes.ScheduledCancelResult {
  return Scheduled.cancelScheduledRuns(buildAccess(core, createTaskContext), taskId, filter);
}

/**
 * Set the adapter timer to wake when the next task is due.
 *
 * `onAlarm` walks alarm hooks directly. By the time a timer fires the engine
 * is already initialized, so the init gate in `handleAlarm` isn't needed.
 */
export function rescheduleAlarm(core: EngineCore): void {
  Scheduled.rescheduleScheduledAlarm({
    requireTimers: () => core.requireTimers(),
    getScheduledRuns: () => core.scheduledRuns,
    getAlarmHandle: () => core.alarmHandle,
    setAlarmHandle: (handle) => {
      core.alarmHandle = handle;
    },
    onAlarm: async () => {
      for (const hook of core.hooks.alarm) {
        await hook();
      }
    },
  });
}
