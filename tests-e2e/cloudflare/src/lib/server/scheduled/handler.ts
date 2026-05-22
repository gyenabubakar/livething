import { contract, implement, incoming, outgoing, scheduled, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

let flakyAttempts = 0;
let defaultRetryAttempts = 0;

export const scheduledContract = contract<Env>('scheduled')({
  meta: t<{ username: string }>(),
  tagGroups: { ephemeral: ['user', 'role'] },
  definitions: [
    incoming('schedule-cleanup', v.object({ delayMs: v.number() })),
    incoming('cancel-cleanup', v.object({})),
    incoming('start-heartbeat', v.object({})),
    incoming('trigger-flaky-task', v.object({})),
    incoming('trigger-default-retry-task', v.object({})),
    incoming('trigger-always-fail', v.object({})),
    incoming('trigger-bigint-throw', v.object({})),
    incoming('query-dead-letter', v.object({})),
    incoming('schedule-filtered-tasks', v.object({})),
    incoming('cancel-filtered-task', v.object({ label: v.string() })),
    incoming('cancel-nothing', v.object({})),
    incoming('trigger-invalid-cleanup-data', v.object({})),
    incoming('trigger-invalid-schedule-time', v.object({})),
    incoming('schedule-send-to-conn', v.object({ connectionId: v.string(), text: v.string() })),
    incoming('who-am-i', v.object({})),
    incoming('trigger-empty-backoff', v.object({})),
    incoming('schedule-broadcast-task', v.object({})),
    incoming('schedule-send-to-tag', v.object({})),
    incoming('tag-vip', v.object({})),
    incoming('cancel-nonexistent', v.object({})),
    incoming('trigger-schedule-unknown-task', v.object({})),

    outgoing('cleanup-done', v.object({ at: v.number() })),
    outgoing('cleanup-cancelled', v.object({})),
    outgoing('heartbeat-tick', v.object({ count: v.number() })),
    outgoing('flaky-task-result', v.object({ attempts: v.number() })),
    outgoing('default-retry-result', v.object({ attempts: v.number() })),
    outgoing(
      'dead-letter-result',
      v.object({
        taskId: v.string(),
        attempts: v.number(),
        error: v.string(),
      }),
    ),
    outgoing('filtered-task-result', v.object({ label: v.string() })),
    outgoing('cancel-nothing-ok', v.object({})),
    outgoing('schedule-guard-error', v.object({ message: v.string() })),
    outgoing('schedule-send-to-conn-delivery', v.object({ text: v.string() })),
    outgoing(
      'schedule-send-to-conn-status',
      v.object({
        connectionId: v.string(),
        delivered: v.boolean(),
      }),
    ),
    outgoing('who-am-i-result', v.object({ connectionId: v.string() })),
    outgoing('broadcast-result', v.object({ text: v.string() })),
    outgoing('send-to-tag-result', v.object({ text: v.string() })),
    outgoing('cancel-nonexistent-ok', v.object({})),
    outgoing(
      'schedule-unknown-task-result',
      v.object({
        rejected: v.boolean(),
        message: v.string(),
      }),
    ),

    scheduled('cleanup'),
    scheduled('heartbeat-tick', { every: 300 }),
    scheduled('flaky-task', { retry: [50, 100, 200] }),
    scheduled('default-retry-task', { retry: true }),
    scheduled('always-fail-task', { retry: [25, 50] }),
    scheduled('bigint-throw-task', { retry: false }),
    scheduled('filtered-cleanup', {
      data: v.object({ label: v.string() }),
      retry: false,
    }),
    scheduled('send-to-conn-task', {
      data: v.object({ connectionId: v.string(), text: v.string() }),
    }),
    scheduled('empty-backoff-task', { retry: false }),
    scheduled('broadcast-task'),
    scheduled('send-to-tag-task'),
  ],
});

export const scheduledHandler = implement(scheduledContract)
  .onUpgrade((req, helpers) => requireUsername(req, helpers))

  .scheduled('cleanup', (ctx) => {
    ctx.broadcast('cleanup-done', { at: Date.now() });
  })
  .scheduled('heartbeat-tick', (ctx) => {
    ctx.broadcast('heartbeat-tick', { count: Date.now() });
  })
  .scheduled('flaky-task', (ctx) => {
    flakyAttempts += 1;
    if (flakyAttempts < 3) throw new Error('flaky');
    ctx.broadcast('flaky-task-result', { attempts: flakyAttempts });
    flakyAttempts = 0;
  })
  .scheduled('default-retry-task', (ctx) => {
    defaultRetryAttempts += 1;
    if (defaultRetryAttempts < 2) throw new Error('retry-once');
    ctx.broadcast('default-retry-result', { attempts: defaultRetryAttempts });
    defaultRetryAttempts = 0;
  })
  .scheduled('always-fail-task', () => {
    throw new Error('permanent failure');
  })
  .scheduled('bigint-throw-task', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw 1n;
  })
  .scheduled('filtered-cleanup', (ctx, data) => {
    ctx.broadcast('filtered-task-result', { label: data.label });
  })
  .scheduled('send-to-conn-task', (ctx, data) => {
    const delivered = ctx.sendToConnection(data.connectionId, 'schedule-send-to-conn-delivery', {
      text: data.text,
    });
    ctx.broadcast('schedule-send-to-conn-status', {
      connectionId: data.connectionId,
      delivered,
    });
  })
  .scheduled('empty-backoff-task', () => {
    throw new Error('always fails with no retry');
  })
  .scheduled('broadcast-task', (ctx) => {
    ctx.broadcast('broadcast-result', { text: 'from-task' });
  })
  .scheduled('send-to-tag-task', (ctx) => {
    for (const conn of ctx.getConnections()) {
      if (
        conn.tags.some(
          (r: { kind: string; group: string; key: string }) =>
            r.kind === 'ephemeral' && r.group === 'role' && r.key === 'vip',
        )
      ) {
        ctx.sendToConnection(conn.id, 'send-to-tag-result', { text: 'tagged-from-task' });
      }
    }
  })

  .on('schedule-cleanup', (ctx, payload) => {
    ctx.schedule('cleanup', { time: Date.now() + payload.delayMs });
  })
  .on('cancel-cleanup', (ctx) => {
    ctx.cancelScheduled('cleanup');
    ctx.send('cleanup-cancelled', {});
  })
  .on('start-heartbeat', (ctx) => {
    ctx.schedule('heartbeat-tick', { time: Date.now() + 100 });
  })
  .on('trigger-flaky-task', (ctx) => {
    flakyAttempts = 0;
    ctx.schedule('flaky-task', { time: Date.now() + 50 });
  })
  .on('trigger-default-retry-task', (ctx) => {
    defaultRetryAttempts = 0;
    ctx.schedule('default-retry-task', { time: Date.now() + 50 });
  })
  .on('trigger-always-fail', (ctx) => {
    ctx.schedule('always-fail-task', { time: Date.now() + 50 });
  })
  .on('trigger-bigint-throw', (ctx) => {
    ctx.schedule('bigint-throw-task', { time: Date.now() + 50 });
  })
  .on('query-dead-letter', (ctx) => {
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
  })
  .on('schedule-filtered-tasks', (ctx) => {
    const time = Date.now() + 300;
    ctx.schedule('filtered-cleanup', { time, data: { label: 'drop' } });
    ctx.schedule('filtered-cleanup', { time, data: { label: 'keep' } });
  })
  .on('cancel-filtered-task', (ctx, payload) => {
    ctx.cancelScheduled('filtered-cleanup', { label: payload.label });
  })
  .on('cancel-nothing', (ctx) => {
    ctx.cancelScheduled('filtered-cleanup', { label: '__never__' });
    ctx.send('cancel-nothing-ok', {});
  })
  .on('trigger-invalid-cleanup-data', (ctx) => {
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
  .on('trigger-invalid-schedule-time', (ctx) => {
    try {
      ctx.schedule('cleanup', { time: Number.NaN });
    } catch (error) {
      ctx.send('schedule-guard-error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
  .on('schedule-send-to-conn', (ctx, payload) => {
    ctx.schedule('send-to-conn-task', {
      time: Date.now() + 50,
      data: { connectionId: payload.connectionId, text: payload.text },
    });
  })
  .on('who-am-i', (ctx) => {
    ctx.send('who-am-i-result', { connectionId: ctx.id });
  })
  .on('trigger-empty-backoff', (ctx) => {
    ctx.schedule('empty-backoff-task', { time: Date.now() + 50 });
  })
  .on('schedule-broadcast-task', (ctx) => {
    ctx.schedule('broadcast-task', { time: Date.now() + 50 });
  })
  .on('schedule-send-to-tag', (ctx) => {
    ctx.schedule('send-to-tag-task', { time: Date.now() + 50 });
  })
  .on('tag-vip', (ctx) => {
    ctx.tags.ephemeral('role').add('vip');
  })
  .on('cancel-nonexistent', (ctx) => {
    (ctx.cancelScheduled as (id: string) => void)('nonexistent-task-id');
    ctx.send('cancel-nonexistent-ok', {});
  })
  .on('trigger-schedule-unknown-task', (ctx) => {
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

export type ScheduledClient = InferClient<typeof scheduledHandler>;
