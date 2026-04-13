import { event } from '@wskit/server';
import * as v from 'valibot';

export const ScheduleCleanup = event('schedule-cleanup', v.object({ delaySec: v.number() }));

export const CleanupDone = event(
  'cleanup-done',
  v.object({ timestamp: v.number(), itemsCleaned: v.number() }),
);
