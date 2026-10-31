import { registerAlarmSource, rescheduleAlarm as rescheduleEngineAlarm } from '~/_engine/alarm.ts';
import { withCallContext } from '~/_engine/async-context.ts';
import * as Scheduled from '~/scheduled/runtime.ts';
import { SCHEDULED_RUNTIME_KEY } from '~/scheduled/scheduled.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { ScheduledService } from '~/_engine/runtime/feature-slots.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';

/** Build the access object the scheduled runtime needs from core + the task `ctx` factory. */
function buildAccess(
  core: EngineCore,
  createContext: () => unknown,
): ScheduledPrimitiveTypes.ScheduledRuntimeAccess {
  return {
    getStorage: () => core.storage,
    generateId: (prefix) => core.generateId(prefix),
    getScheduledRuns: () => core.scheduledRuns,
    getScheduledRunsPersisted: () => core.scheduledRunsPersisted,
    getScheduledTask: (taskId) => core.compiled.scheduled.get(taskId),
    getScheduledTasks: () => core.compiled.scheduled.values(),
    createContext,
    runInTaskCall: (ctx, fn) =>
      withCallContext(core.asyncContext, { kind: 'task', getCtx: () => ctx }, fn),
    rescheduleAlarm: () => rescheduleAlarm(core),
    logger: core.logger,
  };
}

/**
 * Install the scheduled runtime on first use (idempotent). Adds a schema-init
 * hook for the tables, a boot hook that loads the queue, and a scheduled
 * callback hook that drains due runs.
 */
function ensureScheduledRuntime(core: EngineCore, createContext: () => unknown): void {
  if (core.installedFeatures.has(SCHEDULED_RUNTIME_KEY)) return;

  core.installedFeatures.add(SCHEDULED_RUNTIME_KEY);

  registerAlarmSource(core, SCHEDULED_RUNTIME_KEY, () => {
    let next: number | null = null;
    for (const run of core.scheduledRuns.values()) {
      if (next === null || run.time < next) next = run.time;
    }

    return next;
  });

  core.hooks.bootSchema.push(() =>
    Scheduled.ensureScheduledSchema(buildAccess(core, createContext)),
  );
  core.hooks.boot.push(() => Scheduled.bootstrapScheduledRuntime(buildAccess(core, createContext)));
  core.hooks.alarm.push(async () =>
    Scheduled.handleScheduledAlarm(buildAccess(core, createContext)),
  );
}

export interface ScheduleTaskOptions {
  taskId: string;
  time: number;
  data: unknown;
}

/** Queue one future scheduled task run. */
export function scheduleTask(
  core: EngineCore,
  createContext: () => unknown,
  options: ScheduleTaskOptions,
): void {
  Scheduled.scheduleTaskRun(buildAccess(core, createContext), options);
}

interface CancelScheduledOptions {
  taskId: string;
  filter?: Record<string, unknown>;
}

/**
 * Remove every queued run for one scheduled task id. Matching no run is normal
 * (the run already fired, or was never queued), so nothing is logged.
 */
function cancelScheduled(
  core: EngineCore,
  createContext: () => unknown,
  options: CancelScheduledOptions,
): void {
  Scheduled.cancelScheduledRuns(buildAccess(core, createContext), options.taskId, options.filter);
}

/**
 * Set the adapter timer to wake when the next task is due.
 *
 * Walks scheduled hooks directly. By the time a timer fires the engine
 * is already initialized, so the init gate in `handleAlarm` isn't needed.
 */
function rescheduleAlarm(core: EngineCore): void {
  rescheduleEngineAlarm(core);
}

/**
 * The scheduled runtime, reached through the engine's `scheduledService` slot,
 * so the engine core never imports the scheduler.
 */
const scheduledService: ScheduledService = {
  ensureRuntime: (core, createContext) => ensureScheduledRuntime(core, createContext),
  scheduleTask: (core, createContext, opts) => scheduleTask(core, createContext, opts),
  cancelScheduled: (core, createContext, opts) => cancelScheduled(core, createContext, opts),
  rescheduleAlarm: (core) => rescheduleAlarm(core),
};

/** Installs the scheduled service once, set by `scheduled()` or a durable stream. */
const SCHEDULED_SERVICE_KEY = Symbol('livething.scheduledService');

export function registerScheduledService(engine: EngineAccess): void {
  engine.installOnce(SCHEDULED_SERVICE_KEY, () => {
    engine.setScheduledService(scheduledService);
  });
}
