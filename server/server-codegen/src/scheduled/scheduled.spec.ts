import { scheduled } from '~/scheduled/scheduled.ts';
import { t } from '~/t.ts';
import { describe, expect, it } from 'vitest';

describe('scheduled()', () => {
  it('stores the handler form', () => {
    async function cleanup() {}

    const task = scheduled('cleanup', cleanup, { every: 60_000 });

    expect(task.taskId).toBe('cleanup');
    expect(task.handler).toBe(cleanup);
    expect(task.options?.every).toBe(60_000);
    expect(task.__requires.timers).toBe(true);
  });

  it('supports the type-only form', () => {
    const task = scheduled('cleanup', t<{ roomId: string }>());

    expect(task.taskId).toBe('cleanup');
    expect(task.handler).toBeUndefined();
    expect('data' in task).toBe(true);
  });
});
