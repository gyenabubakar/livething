import { withScheduled } from '@wskit/server/scheduled';
import { base } from '../setup.ts';
import { CancelCleanup, ScheduleCleanup } from './events.ts';

export const scheduledHandlers = withScheduled(base).group((g) =>
  g
    .scheduled('cleanup', async (ctx) => {
      const cleaned = Math.floor(Math.random() * 50) + 1;
      ctx.broadcast('cleanup-done', { timestamp: Date.now(), itemsCleaned: cleaned });
    })
    .incoming(ScheduleCleanup, (ctx, payload) => {
      ctx.schedule('cleanup', { time: Date.now() + payload.delaySec * 1000 });
    })
    .incoming(CancelCleanup, (ctx) => {
      ctx.cancelScheduled('cleanup');
      ctx.send('cleanup-cancelled', { success: true });
    }),
);
