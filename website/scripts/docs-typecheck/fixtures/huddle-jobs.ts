// The server from the scheduled page's `server/huddle-jobs.ts` declaration. Keep the two in sync.
import { emits, server, t } from '@livething/server';
import { scheduled } from '@livething/server/scheduled';

export const base = server({
  capabilities: [
    scheduled({
      'purge-old-drafts': null,
      'expire-invites': { every: 3_600_000 },
      'send-digest': { data: t<{ userId: string }>(), retry: true },
    }),
    emits({
      notification: t<{ title: string; body: string }>(),
      'digest-sent': t<{ userId: string }>(),
      'schedule-error': t<{ message: string }>(),
      'dead-letter-result': t<{ taskId: string; attempts: number }>(),
    }),
  ],
});
