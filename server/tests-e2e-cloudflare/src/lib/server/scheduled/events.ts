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
export const TriggerAlwaysFail = event('trigger-always-fail', v.object({}));
export const DeadLetterResult = event(
  'dead-letter-result',
  v.object({ taskId: v.string(), attempts: v.number(), error: v.string() }),
);
