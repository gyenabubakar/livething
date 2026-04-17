import { withScheduled } from '@wskit/server/scheduled';
import { base } from '../setup.ts';
import {
  CancelCleanup,
  CancelFilteredTask,
  ScheduleCleanup,
  ScheduleFilteredTasks,
  StartHeartbeat,
  TriggerAlwaysFail,
  TriggerDefaultRetryTask,
  TriggerFlakyTask,
} from './events.ts';

let flakyAttempts = 0;
let defaultRetryAttempts = 0;

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
    .scheduled(
      'default-retry-task',
      async (ctx) => {
        defaultRetryAttempts++;
        if (defaultRetryAttempts < 2) throw new Error('Retry once with defaults');
        ctx.broadcast('default-retry-result', { attempts: defaultRetryAttempts });
        defaultRetryAttempts = 0;
      },
      { retry: true },
    )
    .scheduled(
      'filtered-cleanup',
      async (ctx, data: { label: string }) => {
        ctx.broadcast('filtered-task-result', { label: data.label });
      },
      { retry: false },
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
    .incoming(TriggerDefaultRetryTask, (ctx) => {
      defaultRetryAttempts = 0;
      ctx.schedule('default-retry-task', { time: Date.now() + 100 });
    })
    .incoming(ScheduleFilteredTasks, (ctx) => {
      const time = Date.now() + 300;
      ctx.schedule('filtered-cleanup', { time, data: { label: 'drop' } });
      ctx.schedule('filtered-cleanup', { time, data: { label: 'keep' } });
    })
    .incoming(CancelFilteredTask, (ctx, payload) => {
      ctx.cancelScheduled('filtered-cleanup', { label: payload.label });
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
