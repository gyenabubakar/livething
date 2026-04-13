import { event } from '@wskit/server';
import * as v from 'valibot';

export const ScheduleCleanup = event('schedule-cleanup', v.object({ delaySec: v.number() }));
export const CancelCleanup = event('cancel-cleanup', v.object({}));

export const CleanupDone = event(
  'cleanup-done',
  v.object({ timestamp: v.number(), itemsCleaned: v.number() }),
);

export const CleanupCancelled = event('cleanup-cancelled', v.object({ success: v.boolean() }));
