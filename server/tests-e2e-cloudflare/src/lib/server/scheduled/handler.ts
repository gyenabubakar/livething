import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withScheduled } from '@wskit/server/scheduled';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const TriggerTask = event('trigger-task', v.object({ delaySec: v.number() }));
const TaskDone = event('task-done', v.object({ timestamp: v.number() }));

export const scheduledHandler = withScheduled(withLifecycle(server<Env>('scheduled')))
  .outgoing(TaskDone)
  .onUpgrade((request) => requireUsername(request))
  .scheduled('my-task', async (ctx) => {
    ctx.broadcast('task-done', { timestamp: Date.now() });
  })
  .incoming(TriggerTask, (ctx, payload) => {
    ctx.schedule('my-task', { time: Date.now() + payload.delaySec * 1000 });
  })
  .build();
