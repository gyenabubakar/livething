import { define, emits, t } from '@wskit/server';
import { scheduled } from '@wskit/server/scheduled';
import { tags } from '@wskit/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsernameWithUserTag } from '../_shared/upgrade.ts';

let flakyAttempts = 0;
let defaultRetryAttempts = 0;

const base = define({
  upgrade: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('role', t<string>())]),
    scheduled({
      cleanup: null,
      'heartbeat-tick': { every: 300 },
      'flaky-task': { retry: [50, 100, 200] },
      'default-retry-task': { retry: true },
      'always-fail-task': { retry: [25, 50] },
      'bigint-throw-task': { retry: false },
      'filtered-cleanup': { data: t<{ label: string }>(), retry: false },
      'send-to-conn-task': { data: t<{ connectionId: string; text: string }>() },
      'empty-backoff-task': { retry: false },
      'broadcast-task': null,
      'send-to-tag-task': null,
    }),
    emits({
      'cleanup-scheduled': t<{}>(),
      'cleanup-done': t<{ at: number }>(),
      'cleanup-history-result': t<{ ranAt: number | null }>(),
      'cleanup-cancelled': t<{}>(),
      'heartbeat-tick': t<{ count: number }>(),
      'flaky-task-result': t<{ attempts: number }>(),
      'default-retry-result': t<{ attempts: number }>(),
      'dead-letter-result': t<{ taskId: string; attempts: number; error: string }>(),
      'filtered-task-result': t<{ label: string }>(),
      'cancel-nothing-ok': t<{}>(),
      'schedule-guard-error': t<{ message: string }>(),
      'schedule-send-to-conn-delivery': t<{ text: string }>(),
      'schedule-send-to-conn-status': t<{ connectionId: string; delivered: boolean }>(),
      'who-am-i-result': t<{ connectionId: string }>(),
      'broadcast-result': t<{ text: string }>(),
      'send-to-tag-result': t<{ text: string }>(),
      'cancel-nonexistent-ok': t<{}>(),
      'schedule-unknown-task-result': t<{ rejected: boolean; message: string }>(),
    }),
  ],
});

base.onInit((ctx) => {
  ctx.sql.exec(
    'CREATE TABLE IF NOT EXISTS _cleanup_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ranAt INTEGER NOT NULL)',
  );
});

base.scheduled('cleanup', {
  run(ctx) {
    const ranAt = Date.now();
    ctx.sql.exec('INSERT INTO _cleanup_log (ranAt) VALUES (?)', ranAt);
    ctx.broadcast('cleanup-done', { at: ranAt });
  },
});

base.scheduled('heartbeat-tick', {
  run(ctx) {
    ctx.broadcast('heartbeat-tick', { count: Date.now() });
  },
});

base.scheduled('flaky-task', {
  run(ctx) {
    flakyAttempts += 1;
    if (flakyAttempts < 3) throw new Error('flaky');
    ctx.broadcast('flaky-task-result', { attempts: flakyAttempts });
    flakyAttempts = 0;
  },
});

base.scheduled('default-retry-task', {
  run(ctx) {
    defaultRetryAttempts += 1;
    if (defaultRetryAttempts < 2) throw new Error('retry-once');
    ctx.broadcast('default-retry-result', { attempts: defaultRetryAttempts });
    defaultRetryAttempts = 0;
  },
});

base.scheduled('always-fail-task', {
  run() {
    throw new Error('permanent failure');
  },
});

base.scheduled('bigint-throw-task', {
  run() {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw 1n;
  },
});

base.scheduled('filtered-cleanup', {
  run(ctx, data) {
    ctx.broadcast('filtered-task-result', { label: data.label });
  },
});

base.scheduled('send-to-conn-task', {
  run(ctx, data) {
    const target = ctx.connections.all().find((info) => info.id === data.connectionId);
    const delivered = target
      ? ctx.connections.get(target.ref()).send('schedule-send-to-conn-delivery', {
          text: data.text,
        })
      : false;
    ctx.broadcast('schedule-send-to-conn-status', {
      connectionId: data.connectionId,
      delivered,
    });
  },
});

base.scheduled('empty-backoff-task', {
  run() {
    throw new Error('always fails with no retry');
  },
});

base.scheduled('broadcast-task', {
  run(ctx) {
    ctx.broadcast('broadcast-result', { text: 'from-task' });
  },
});

base.scheduled('send-to-tag-task', {
  run(ctx) {
    for (const conn of ctx.connections.all()) {
      if (conn.tags.some((r) => r.kind === 'ephemeral' && r.group === 'role' && r.key === 'vip')) {
        ctx.connections.get(conn.ref()).send('send-to-tag-result', { text: 'tagged-from-task' });
      }
    }
  },
});

const handleScheduleCleanup = base.on('schedule-cleanup', {
  input: v.object({ delayMs: v.number() }),
  run(ctx, input) {
    ctx.schedule('cleanup', { time: Date.now() + input.delayMs });
    ctx.send('cleanup-scheduled', {});
  },
});

const handleQueryCleanupHistory = base.on('query-cleanup-history', {
  input: v.object({}),
  run(ctx) {
    const row = ctx.sql
      .exec<{ ranAt: number }>('SELECT ranAt FROM _cleanup_log ORDER BY id DESC LIMIT 1')
      .one();
    ctx.send('cleanup-history-result', { ranAt: row ? Number(row.ranAt) : null });
  },
});

const handleCancelCleanup = base.on('cancel-cleanup', {
  input: v.object({}),
  run(ctx) {
    ctx.cancelScheduled('cleanup');
    ctx.send('cleanup-cancelled', {});
  },
});

const handleStartHeartbeat = base.on('start-heartbeat', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('heartbeat-tick', { time: Date.now() + 100 });
  },
});

const handleCancelHeartbeat = base.on('cancel-heartbeat', {
  input: v.object({}),
  run(ctx) {
    ctx.cancelScheduled('heartbeat-tick');
    ctx.send('cleanup-cancelled', {});
  },
});

const handleTriggerFlakyTask = base.on('trigger-flaky-task', {
  input: v.object({}),
  run(ctx) {
    flakyAttempts = 0;
    ctx.schedule('flaky-task', { time: Date.now() + 50 });
  },
});

const handleTriggerDefaultRetryTask = base.on('trigger-default-retry-task', {
  input: v.object({}),
  run(ctx) {
    defaultRetryAttempts = 0;
    ctx.schedule('default-retry-task', { time: Date.now() + 50 });
  },
});

const handleTriggerAlwaysFail = base.on('trigger-always-fail', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('always-fail-task', { time: Date.now() + 50 });
  },
});

const handleTriggerBigintThrow = base.on('trigger-bigint-throw', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('bigint-throw-task', { time: Date.now() + 50 });
  },
});

const handleQueryDeadLetter = base.on('query-dead-letter', {
  input: v.object({}),
  run(ctx) {
    const rows = ctx.sql
      .exec<{
        taskId: string;
        attempts: number;
        error: string;
      }>('SELECT taskId, attempts, error FROM __wskit_scheduled_dlq ORDER BY failedAt DESC LIMIT 1')
      .toArray();
    const row = rows[0];
    if (!row) return;

    const parsed = JSON.parse(row.error) as { message: string };
    ctx.send('dead-letter-result', {
      taskId: row.taskId,
      attempts: row.attempts,
      error: parsed.message,
    });
  },
});

const handleScheduleFilteredTasks = base.on('schedule-filtered-tasks', {
  input: v.object({}),
  run(ctx) {
    const time = Date.now() + 300;
    ctx.schedule('filtered-cleanup', { time, data: { label: 'drop' } });
    ctx.schedule('filtered-cleanup', { time, data: { label: 'keep' } });
  },
});

const handleCancelFilteredTask = base.on('cancel-filtered-task', {
  input: v.object({ label: v.string() }),
  run(ctx, input) {
    ctx.cancelScheduled('filtered-cleanup', { label: input.label });
  },
});

const handleCancelNothing = base.on('cancel-nothing', {
  input: v.object({}),
  run(ctx) {
    ctx.cancelScheduled('filtered-cleanup', { label: '__never__' });
    ctx.send('cancel-nothing-ok', {});
  },
});

const handleTriggerInvalidCleanupData = base.on('trigger-invalid-cleanup-data', {
  input: v.object({}),
  run(ctx) {
    try {
      (ctx.schedule as (taskId: string, options: { time: number; data?: unknown }) => void)(
        'cleanup',
        {
          time: Date.now() + 50,
          data: { nope: true },
        },
      );
    } catch (error) {
      ctx.send('schedule-guard-error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

const handleTriggerInvalidScheduleTime = base.on('trigger-invalid-schedule-time', {
  input: v.object({}),
  run(ctx) {
    try {
      ctx.schedule('cleanup', { time: Number.NaN });
    } catch (error) {
      ctx.send('schedule-guard-error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

const handleScheduleSendToConn = base.on('schedule-send-to-conn', {
  input: v.object({ connectionId: v.string(), text: v.string() }),
  run(ctx, input) {
    ctx.schedule('send-to-conn-task', {
      time: Date.now() + 50,
      data: { connectionId: input.connectionId, text: input.text },
    });
  },
});

const handleWhoAmI = base.on('who-am-i', {
  input: v.object({}),
  run(ctx) {
    ctx.send('who-am-i-result', { connectionId: ctx.connection.id });
  },
});

const handleTriggerEmptyBackoff = base.on('trigger-empty-backoff', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('empty-backoff-task', { time: Date.now() + 50 });
  },
});

const handleScheduleBroadcastTask = base.on('schedule-broadcast-task', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('broadcast-task', { time: Date.now() + 50 });
  },
});

const handleScheduleSendToTag = base.on('schedule-send-to-tag', {
  input: v.object({}),
  run(ctx) {
    ctx.schedule('send-to-tag-task', { time: Date.now() + 50 });
  },
});

const handleTagVip = base.on('tag-vip', {
  input: v.object({}),
  run(ctx) {
    ctx.tags.ephemeral('role').add('vip');
  },
});

const handleCancelNonexistent = base.on('cancel-nonexistent', {
  input: v.object({}),
  run(ctx) {
    (ctx.cancelScheduled as (id: string) => void)('nonexistent-task-id');
    ctx.send('cancel-nonexistent-ok', {});
  },
});

const handleTriggerScheduleUnknownTask = base.on('trigger-schedule-unknown-task', {
  input: v.object({}),
  run(ctx) {
    let rejected = false;
    let message = '';
    try {
      (ctx.schedule as (id: string, opts: { time: number }) => void)(
        'typo-task-id-that-is-not-registered',
        {
          time: Date.now() + 60_000,
        },
      );
    } catch (err) {
      rejected = true;
      message = (err as Error).message;
    }

    ctx.send('schedule-unknown-task-result', { rejected, message });
  },
});

export const scheduledHandler = base.assemble({
  handlers: [
    handleScheduleCleanup,
    handleQueryCleanupHistory,
    handleCancelCleanup,
    handleStartHeartbeat,
    handleCancelHeartbeat,
    handleTriggerFlakyTask,
    handleTriggerDefaultRetryTask,
    handleTriggerAlwaysFail,
    handleTriggerBigintThrow,
    handleQueryDeadLetter,
    handleScheduleFilteredTasks,
    handleCancelFilteredTask,
    handleCancelNothing,
    handleTriggerInvalidCleanupData,
    handleTriggerInvalidScheduleTime,
    handleScheduleSendToConn,
    handleWhoAmI,
    handleTriggerEmptyBackoff,
    handleScheduleBroadcastTask,
    handleScheduleSendToTag,
    handleTagVip,
    handleCancelNonexistent,
    handleTriggerScheduleUnknownTask,
  ],
});

export type ScheduledClient = InferClient<typeof scheduledHandler>;
