import { withScheduled } from '@wskit/server/scheduled';
import { base } from '../setup.ts';
import {
  CancelCleanup,
  ScheduleCleanup,
  StartHeartbeat,
  TriggerAlwaysFail,
  TriggerFlakyTask,
} from './events.ts';

let flakyAttempts = 0;

export const scheduledHandlers = withScheduled(base).group((g) =>
  g
    .scheduled('cleanup', async (ctx) => {
      const cleaned = Math.floor(Math.random() * 50) + 1;
      ctx.broadcast('cleanup-done', { timestamp: Date.now(), itemsCleaned: cleaned });
    })
    .scheduled(
      'heartbeat-tick',
      async (ctx) => {
        ctx.broadcast('heartbeat-tick', { count: Date.now() });
      },
      { every: 2_000 },
    )
    .scheduled(
      'flaky-task',
      async (ctx) => {
        flakyAttempts++;
        if (flakyAttempts < 3) throw new Error('Flaky failure');
        ctx.broadcast('flaky-task-result', { attempts: flakyAttempts });
        flakyAttempts = 0;
      },
      { retry: [50, 100, 200] },
    )
    .incoming(ScheduleCleanup, (ctx, payload) => {
      ctx.schedule('cleanup', { time: Date.now() + payload.delaySec * 1000 });
    })
    .incoming(CancelCleanup, (ctx) => {
      ctx.cancelScheduled('cleanup');
      ctx.send('cleanup-cancelled', { success: true });
    })
    .incoming(StartHeartbeat, (ctx) => {
      ctx.schedule('heartbeat-tick', { time: Date.now() + 500 });
    })
    .incoming(TriggerFlakyTask, (ctx) => {
      ctx.schedule('flaky-task', { time: Date.now() + 100 });
    })
    .scheduled(
      'always-fail-task',
      async () => {
        throw new Error('permanent failure');
      },
      { retry: [50, 100] },
    )
    .incoming(TriggerAlwaysFail, (ctx) => {
      ctx.schedule('always-fail-task', { time: Date.now() + 100 });
    }),
);
