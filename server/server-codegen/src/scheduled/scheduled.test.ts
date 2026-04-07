import { scheduled } from '~/scheduled/scheduled.ts';
import { t } from '~/t.ts';
import type { ScheduledOptions } from '~/scheduled/scheduled.ts';

const typed = scheduled('cleanup', t<{ roomId: string }>());
const handled = scheduled('flush', async (_ctx, data: { force: boolean }) => {
  void data.force;
});
const handledWithOptions = scheduled(
  'archive',
  async (_ctx, data: { roomId: string }) => {
    void data.roomId;
  },
  { retry: false, every: 60_000 },
);

const options: ScheduledOptions = {
  every: 5_000,
  retry: false,
};

const _typedTag: 'scheduled' = typed.__wskit;
const _typedTaskId: 'cleanup' = typed.taskId;
const _handledTaskId: 'flush' = handled.taskId;
const _handledWithOptionsTaskId: 'archive' = handledWithOptions.taskId;
const _requiresTimers: boolean | undefined = handled.__requires.timers;
const _typedData = typed.data;
const _retryOption: boolean | undefined = options.retry;
void [
  _typedTag,
  _typedTaskId,
  _handledTaskId,
  _handledWithOptionsTaskId,
  _requiresTimers,
  _typedData,
  _retryOption,
];
