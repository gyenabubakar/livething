import * as ScheduledContext from '~/scheduled/context.ts';
import * as Scheduled from '~/scheduled/runtime.ts';
import { SCHEDULED_RUNTIME_KEY } from '~/scheduled/scheduled.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { ScheduledService } from '~/_engine/runtime/feature-slots.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';

/** Build the access object the scheduled runtime needs from core + task-context factory. */
function buildAccess(
  core: EngineCore,
  createTaskContext: () => unknown,
): ScheduledPrimitiveTypes.ScheduledRuntimeAccess {
  return {
    getStorage: () => core.storage,
    getTimers: () => core.timers,
    generateId: (prefix) => core.generateId(prefix),
    getScheduledRuns: () => core.scheduledRuns,
    getScheduledDlq: () => core.scheduledDlq,
    getScheduledRunsPersisted: () => core.scheduledRunsPersisted,
    getScheduledDlqPersisted: () => core.scheduledDlqPersisted,
    getScheduledTask: (taskId) => core.compiled.scheduled.get(taskId),
    getScheduledTasks: () => core.compiled.scheduled.values(),
    createTaskContext,
    rescheduleAlarm: () => rescheduleAlarm(core),
    logger: core.logger,
  };
}

/**
 * Install the scheduled runtime on first use (idempotent). Adds a schema-init
 * hook for the tables, a boot hook that loads the queue, and a scheduled
 * callback hook that drains due runs.
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

export interface ScheduleTaskOptions {
  taskId: string;
  time: number;
  data: unknown;
}

/** Queue one future scheduled task run. */
export function scheduleTask(
  core: EngineCore,
  createTaskContext: () => unknown,
  options: ScheduleTaskOptions,
): void {
  Scheduled.scheduleTaskRun(buildAccess(core, createTaskContext), options);
}

export interface CancelScheduledOptions {
  taskId: string;
  filter?: Record<string, unknown>;
}

/** Remove every queued run for one scheduled task id. */
export function cancelScheduled(
  core: EngineCore,
  createTaskContext: () => unknown,
  options: CancelScheduledOptions,
): ScheduledPrimitiveTypes.ScheduledCancelResult {
  return Scheduled.cancelScheduledRuns(
    buildAccess(core, createTaskContext),
    options.taskId,
    options.filter,
  );
}

/**
 * Set the adapter timer to wake when the next task is due.
 *
 * Walks scheduled hooks directly. By the time a timer fires the engine
 * is already initialized, so the init gate in `handleAlarm` isn't needed.
 */
export function rescheduleAlarm(core: EngineCore): void {
  Scheduled.rescheduleScheduledAlarm({
    getTimers: () => core.timers,
    getScheduledRuns: () => core.scheduledRuns,
  });
}

/** Build a fresh scheduled task context from the engine's common messaging deps. */
function taskContextFactory(
  core: EngineCore,
  commonDeps: EngineContextTypes.ContextCommonDeps,
): () => unknown {
  return () =>
    ScheduledContext.createTaskContext({
      connections: core.connections,
      usersByKey: core.usersByKey,
      ...commonDeps,
    });
}

/**
 * The scheduled runtime, reached through the engine's `scheduledService` slot.
 * It owns the task-context construction, so the engine core never imports the
 * scheduler or the scheduled context builder.
 */
export const scheduledService: ScheduledService = {
  ensureRuntime: (core, commonDeps) =>
    ensureScheduledRuntime(core, taskContextFactory(core, commonDeps)),
  scheduleTask: (core, commonDeps, opts) =>
    scheduleTask(core, taskContextFactory(core, commonDeps), opts),
  cancelScheduled: (core, commonDeps, opts) =>
    cancelScheduled(core, taskContextFactory(core, commonDeps), opts),
  rescheduleAlarm: (core) => rescheduleAlarm(core),
  createTaskContext: (core, commonDeps) => taskContextFactory(core, commonDeps)(),
};

/** Installs the scheduled service once, set by `scheduled()` or a durable stream. */
const SCHEDULED_SERVICE_KEY = Symbol('wskit.scheduledService');

export function registerScheduledService(engine: EngineAccess): void {
  engine.installOnce(SCHEDULED_SERVICE_KEY, () => {
    engine.setScheduledService(scheduledService);
  });
}
