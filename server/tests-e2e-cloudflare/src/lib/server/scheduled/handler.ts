import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withScheduled } from '@wskit/server/scheduled';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

// --- events: triggers (incoming) + results (outgoing) -----------------------

const ScheduleCleanup = event('schedule-cleanup', v.object({ delayMs: v.number() }));
const CancelCleanup = event('cancel-cleanup', v.object({}));
const CleanupDone = event('cleanup-done', v.object({ at: v.number() }));
const CleanupCancelled = event('cleanup-cancelled', v.object({}));

const StartHeartbeat = event('start-heartbeat', v.object({}));
const HeartbeatTick = event('heartbeat-tick', v.object({ count: v.number() }));

const TriggerFlakyTask = event('trigger-flaky-task', v.object({}));
const FlakyTaskResult = event('flaky-task-result', v.object({ attempts: v.number() }));
const TriggerDefaultRetryTask = event('trigger-default-retry-task', v.object({}));
const DefaultRetryResult = event('default-retry-result', v.object({ attempts: v.number() }));

const TriggerAlwaysFail = event('trigger-always-fail', v.object({}));
const QueryDeadLetter = event('query-dead-letter', v.object({}));
const DeadLetterResult = event(
  'dead-letter-result',
  v.object({ taskId: v.string(), attempts: v.number(), error: v.string() }),
);

const ScheduleFilteredTasks = event('schedule-filtered-tasks', v.object({}));
const CancelFilteredTask = event('cancel-filtered-task', v.object({ label: v.string() }));
const FilteredTaskResult = event('filtered-task-result', v.object({ label: v.string() }));

const CancelNothing = event('cancel-nothing', v.object({}));
const CancelNothingOk = event('cancel-nothing-ok', v.object({}));

const ScheduleSendToConn = event(
  'schedule-send-to-conn',
  v.object({ connectionId: v.string(), text: v.string() }),
);
const ScheduleSendToConnDelivery = event(
  'schedule-send-to-conn-delivery',
  v.object({ text: v.string() }),
);
const ScheduleSendToConnStatus = event(
  'schedule-send-to-conn-status',
  v.object({ connectionId: v.string(), delivered: v.boolean() }),
);

const WhoAmI = event('who-am-i', v.object({}));
const WhoAmIResult = event('who-am-i-result', v.object({ connectionId: v.string() }));

// --- handler ---------------------------------------------------------------

let flakyAttempts = 0;
let defaultRetryAttempts = 0;

export const scheduledHandler = withScheduled(withLifecycle(server<Env>('scheduled')))
  .outgoing(CleanupDone)
  .outgoing(CleanupCancelled)
  .outgoing(HeartbeatTick)
  .outgoing(FlakyTaskResult)
  .outgoing(DefaultRetryResult)
  .outgoing(DeadLetterResult)
  .outgoing(FilteredTaskResult)
  .outgoing(CancelNothingOk)
  .outgoing(ScheduleSendToConnDelivery)
  .outgoing(ScheduleSendToConnStatus)
  .outgoing(WhoAmIResult)
  .onUpgrade((request) => requireUsername(request))
  .scheduled('cleanup', (ctx) => {
    ctx.broadcast('cleanup-done', { at: Date.now() });
  })
  .scheduled(
    'heartbeat-tick',
    (ctx) => {
      ctx.broadcast('heartbeat-tick', { count: Date.now() });
    },
    { every: 300 },
  )
  .scheduled(
    'flaky-task',
    (ctx) => {
      flakyAttempts += 1;
      if (flakyAttempts < 3) throw new Error('flaky');
      ctx.broadcast('flaky-task-result', { attempts: flakyAttempts });
      flakyAttempts = 0;
    },
    { retry: [50, 100, 200] },
  )
  .scheduled(
    'default-retry-task',
    (ctx) => {
      defaultRetryAttempts += 1;
      if (defaultRetryAttempts < 2) throw new Error('retry-once');
      ctx.broadcast('default-retry-result', { attempts: defaultRetryAttempts });
      defaultRetryAttempts = 0;
    },
    { retry: true },
  )
  .scheduled(
    'always-fail-task',
    () => {
      throw new Error('permanent failure');
    },
    { retry: [25, 50] },
  )
  .scheduled(
    'filtered-cleanup',
    (ctx, data: { label: string }) => {
      ctx.broadcast('filtered-task-result', { label: data.label });
    },
    { retry: false },
  )
  .scheduled('send-to-conn-task', (ctx, data: { connectionId: string; text: string }) => {
    const delivered = ctx.sendToConnection(data.connectionId, 'schedule-send-to-conn-delivery', {
      text: data.text,
    });
    ctx.broadcast('schedule-send-to-conn-status', {
      connectionId: data.connectionId,
      delivered,
    });
  })
  .incoming(ScheduleCleanup, (ctx, payload) => {
    ctx.schedule('cleanup', { time: Date.now() + payload.delayMs });
  })
  .incoming(CancelCleanup, (ctx) => {
    ctx.cancelScheduled('cleanup');
    ctx.send('cleanup-cancelled', {});
  })
  .incoming(StartHeartbeat, (ctx) => {
    ctx.schedule('heartbeat-tick', { time: Date.now() + 100 });
  })
  .incoming(TriggerFlakyTask, (ctx) => {
    flakyAttempts = 0;
    ctx.schedule('flaky-task', { time: Date.now() + 50 });
  })
  .incoming(TriggerDefaultRetryTask, (ctx) => {
    defaultRetryAttempts = 0;
    ctx.schedule('default-retry-task', { time: Date.now() + 50 });
  })
  .incoming(TriggerAlwaysFail, (ctx) => {
    ctx.schedule('always-fail-task', { time: Date.now() + 50 });
  })
  .incoming(QueryDeadLetter, (ctx) => {
    const rows = ctx.sql
      .exec(
        'SELECT taskId, attempts, error FROM _wskit_scheduled_dlq ORDER BY failedAt DESC LIMIT 1',
      )
      .toArray() as { taskId: string; attempts: number; error: string }[];
    const row = rows[0];
    if (!row) return;
    const parsed = JSON.parse(row.error) as { message: string };
    ctx.send('dead-letter-result', {
      taskId: row.taskId,
      attempts: row.attempts,
      error: parsed.message,
    });
  })
  .incoming(ScheduleFilteredTasks, (ctx) => {
    const time = Date.now() + 300;
    ctx.schedule('filtered-cleanup', { time, data: { label: 'drop' } });
    ctx.schedule('filtered-cleanup', { time, data: { label: 'keep' } });
  })
  .incoming(CancelFilteredTask, (ctx, payload) => {
    ctx.cancelScheduled('filtered-cleanup', { label: payload.label });
  })
  .incoming(CancelNothing, (ctx) => {
    // Real task id + a filter field that never matches any stored run,
    // exercising the "nothing to cancel" no-op branch.
    ctx.cancelScheduled('filtered-cleanup', { label: '__never__' });
    ctx.send('cancel-nothing-ok', {});
  })
  .incoming(ScheduleSendToConn, (ctx, payload) => {
    ctx.schedule('send-to-conn-task', {
      time: Date.now() + 50,
      data: { connectionId: payload.connectionId, text: payload.text },
    });
  })
  .incoming(WhoAmI, (ctx) => {
    ctx.send('who-am-i-result', { connectionId: ctx.id });
  })
  .build();
