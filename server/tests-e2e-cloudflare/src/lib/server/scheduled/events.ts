import { event } from '@wskit/server';
import * as v from 'valibot';

export const ScheduleCleanup = event('schedule-cleanup', v.object({ delaySec: v.number() }));
export const CancelCleanup = event('cancel-cleanup', v.object({}));

export const CleanupDone = event(
  'cleanup-done',
  v.object({ timestamp: v.number(), itemsCleaned: v.number() }),
);

export const CleanupCancelled = event('cleanup-cancelled', v.object({ success: v.boolean() }));

export const StartHeartbeat = event('start-heartbeat', v.object({}));
export const HeartbeatTick = event('heartbeat-tick', v.object({ count: v.number() }));
export const TriggerFlakyTask = event('trigger-flaky-task', v.object({}));
export const FlakyTaskResult = event('flaky-task-result', v.object({ attempts: v.number() }));
export const TriggerDefaultRetryTask = event('trigger-default-retry-task', v.object({}));
export const DefaultRetryResult = event('default-retry-result', v.object({ attempts: v.number() }));
export const TriggerAlwaysFail = event('trigger-always-fail', v.object({}));
export const DeadLetterResult = event(
  'dead-letter-result',
  v.object({ taskId: v.string(), attempts: v.number(), error: v.string() }),
);

export const ScheduleSendToConn = event(
  'schedule-send-to-conn',
  v.object({ connectionId: v.string(), text: v.string() }),
);
export const ScheduleSendToConnStatus = event(
  'schedule-send-to-conn-status',
  v.object({ connectionId: v.string(), delivered: v.boolean() }),
);
export const ScheduleSendToConnDelivery = event(
  'schedule-send-to-conn-delivery',
  v.object({ text: v.string() }),
);

export const ScheduleFilteredTasks = event('schedule-filtered-tasks', v.object({}));
export const CancelFilteredTask = event('cancel-filtered-task', v.object({ label: v.string() }));
export const FilteredTaskResult = event('filtered-task-result', v.object({ label: v.string() }));

export const CancelNothing = event('cancel-nothing', v.object({}));
export const CancelNothingOk = event('cancel-nothing-ok', v.object({}));
