import { scheduled } from '~/scheduled/scheduled.ts';
import { t } from '~/t.ts';

const typed = scheduled('cleanup', t<{ roomId: string }>());
const handled = scheduled('flush', async (_ctx, data: { force: boolean }) => {
  void data.force;
});

const _typedTag: 'scheduled' = typed.__wskit;
const _typedTaskId: 'cleanup' = typed.taskId;
const _handledTaskId: 'flush' = handled.taskId;
const _requiresTimers: boolean | undefined = handled.__requires.timers;
void [_typedTag, _typedTaskId, _handledTaskId, _requiresTimers];
