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
const TriggerInvalidCleanupData = event('trigger-invalid-cleanup-data', v.object({}));
const ScheduleGuardError = event('schedule-guard-error', v.object({ message: v.string() }));

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

const TriggerEmptyBackoff = event('trigger-empty-backoff', v.object({}));
const ScheduleBroadcastTask = event('schedule-broadcast-task', v.object({}));
const BroadcastResult = event('broadcast-result', v.object({ text: v.string() }));
const ScheduleSendToTag = event('schedule-send-to-tag', v.object({}));
const SendToTagResult = event('send-to-tag-result', v.object({ text: v.string() }));
const TagVip = event('tag-vip', v.object({}));
const CancelNonexistent = event('cancel-nonexistent', v.object({}));
const CancelNonexistentOk = event('cancel-nonexistent-ok', v.object({}));

const TriggerScheduleUnknownTask = event('trigger-schedule-unknown-task', v.object({}));
const ScheduleUnknownTaskResult = event(
  'schedule-unknown-task-result',
  v.object({ rejected: v.boolean(), message: v.string() }),
);

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
  .outgoing(ScheduleGuardError)
  .outgoing(ScheduleSendToConnDelivery)
  .outgoing(ScheduleSendToConnStatus)
  .outgoing(WhoAmIResult)
  .outgoing(BroadcastResult)
  .outgoing(SendToTagResult)
  .outgoing(CancelNonexistentOk)
  .outgoing(ScheduleUnknownTaskResult)
  .onUpgrade((request) => requireUsername(request))
  .scheduled('cleanup', (t) =>
    t.run((ctx) => {
      ctx.broadcast('cleanup-done', { at: Date.now() });
    }),
  )
  .scheduled('heartbeat-tick', (t) =>
    t.every(300).run((ctx) => {
      ctx.broadcast('heartbeat-tick', { count: Date.now() });
    }),
  )
  .scheduled('flaky-task', (t) =>
    t.retry([50, 100, 200]).run((ctx) => {
      flakyAttempts += 1;
      if (flakyAttempts < 3) throw new Error('flaky');
      ctx.broadcast('flaky-task-result', { attempts: flakyAttempts });
      flakyAttempts = 0;
    }),
  )
  .scheduled('default-retry-task', (t) =>
    t.retry(true).run((ctx) => {
      defaultRetryAttempts += 1;
      if (defaultRetryAttempts < 2) throw new Error('retry-once');
      ctx.broadcast('default-retry-result', { attempts: defaultRetryAttempts });
      defaultRetryAttempts = 0;
    }),
  )
  .scheduled('always-fail-task', (t) =>
    t.retry([25, 50]).run(() => {
      throw new Error('permanent failure');
    }),
  )
  .scheduled('filtered-cleanup', (t) =>
    t
      .data(v.object({ label: v.string() }))
      .retry(false)
      .run((ctx, data) => {
        ctx.broadcast('filtered-task-result', { label: data.label });
      }),
  )
  .scheduled('send-to-conn-task', (t) =>
    t.data(v.object({ connectionId: v.string(), text: v.string() })).run((ctx, data) => {
      const delivered = ctx.sendToConnection(data.connectionId, 'schedule-send-to-conn-delivery', {
        text: data.text,
      });
      ctx.broadcast('schedule-send-to-conn-status', {
        connectionId: data.connectionId,
        delivered,
      });
    }),
  )
  .scheduled('empty-backoff-task', (t) =>
    t.retry(false).run(() => {
      throw new Error('always fails with no retry');
    }),
  )
  .scheduled('broadcast-task', (t) =>
    t.run((ctx) => {
      ctx.broadcast('broadcast-result', { text: 'from-task' });
    }),
  )
  .scheduled('send-to-tag-task', (t) =>
    t.run((ctx) => {
      ctx.sendTo('vip', 'send-to-tag-result', { text: 'tagged-from-task' });
    }),
  )
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
      .exec<{
        taskId: string;
        attempts: number;
        error: string;
      }>('SELECT taskId, attempts, error FROM _wskit_scheduled_dlq ORDER BY failedAt DESC LIMIT 1')
      .toArray();
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
  .incoming(TriggerInvalidCleanupData, (ctx) => {
    try {
      (ctx.schedule as (taskId: string, options: { time: number; data?: unknown }) => void)(
        'cleanup',
        { time: Date.now() + 50, data: { nope: true } },
      );
    } catch (error) {
      ctx.send('schedule-guard-error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
  .incoming(TriggerEmptyBackoff, (ctx) => {
    ctx.schedule('empty-backoff-task', { time: Date.now() + 50 });
  })
  .incoming(ScheduleBroadcastTask, (ctx) => {
    ctx.schedule('broadcast-task', { time: Date.now() + 50 });
  })
  .incoming(ScheduleSendToTag, (ctx) => {
    ctx.schedule('send-to-tag-task', { time: Date.now() + 50 });
  })
  .incoming(TagVip, (ctx) => {
    ctx.tag('vip');
  })
  .incoming(CancelNonexistent, (ctx) => {
    // Cast to bypass the type guard: test that cancelling an unknown id at runtime is a no-op.
    (ctx.cancelScheduled as (id: string) => void)('nonexistent-task-id');
    ctx.send('cancel-nonexistent-ok', {});
  })
  .incoming(TriggerScheduleUnknownTask, (ctx) => {
    // ctx.schedule with an unregistered task id must throw synchronously so
    // typos surface at schedule time instead of silently being queued and
    // dropped when the alarm later finds no handler.
    let rejected = false;
    let message = '';
    try {
      (ctx.schedule as (id: string, opts: { time: number }) => void)(
        'typo-task-id-that-is-not-registered',
        { time: Date.now() + 60_000 },
      );
    } catch (err) {
      rejected = true;
      message = (err as Error).message;
    }
    ctx.send('schedule-unknown-task-result', { rejected, message });
  })
  .build();
