import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

test.describe('scheduled', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/scheduled?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('scheduled task fires after the given delay', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('schedule-cleanup-soon').click();
    await expect(page.getByTestId('cleanup-fired')).toHaveText('yes');
  });

  test('cancel scheduled task prevents the fire', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Schedule with a long delay so the cancel wins the race.
    await page.getByTestId('schedule-cleanup-long').click();
    await page.getByTestId('cancel-cleanup').click();
    await expect(page.getByTestId('cleanup-cancelled')).toHaveText('yes');
    await expect(page.getByTestId('cleanup-fired')).toHaveText('no');
  });

  test('schedule then immediately cancel (cancel before fire)', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('schedule-cleanup-long').click();
    await page.getByTestId('cancel-cleanup').click();
    await expect(page.getByTestId('cleanup-cancelled')).toHaveText('yes');
    // Positive signal the connection stayed healthy.
    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('connection-id')).not.toHaveText('');
    await expect(page.getByTestId('cleanup-fired')).toHaveText('no');
  });

  test('scheduled { every } fires repeatedly', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-heartbeat').click();
    // Handler is configured with every: 300ms; assert >=2 ticks within 10s.
    await expect(async () => {
      const txt = (await page.getByTestId('heartbeat-count').textContent()) ?? '0';
      expect(Number(txt)).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 10_000 });
  });

  test('scheduled retry: flaky task succeeds after custom backoff', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('trigger-flaky').click();
    // Handler throws twice, succeeds on attempt 3.
    await expect(page.getByTestId('flaky-attempts')).toHaveText('3');
  });

  test('scheduled retry: default retry succeeds after one retry', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('trigger-default-retry').click();
    await expect(page.getByTestId('default-retry-attempts')).toHaveText('2');
  });

  test('cancelScheduled filter cancels only matching runs', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('schedule-filtered').click();
    await page.getByTestId('cancel-drop').click();
    // 'keep' should fire; 'drop' was cancelled.
    await expect(page.getByTestId('filtered-labels')).toContainText('keep');
    await expect(page.getByTestId('filtered-labels')).not.toContainText('drop');
  });

  test('cancelScheduled with no matching task id leaves the connection healthy', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('cancel-nothing').click();
    await expect(page.getByTestId('cancel-nothing-ok')).toHaveText('yes');
    // Positive signal: connection still healthy, future tasks still work.
    await page.getByTestId('schedule-cleanup-soon').click();
    await expect(page.getByTestId('cleanup-fired')).toHaveText('yes');
  });

  test('schedule guard rejects data for no-data tasks without killing the connection', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('trigger-invalid-cleanup-data').click();
    await expect(page.getByTestId('schedule-guard-error')).toContainText('declares no data');
    await page.getByTestId('schedule-cleanup-soon').click();
    await expect(page.getByTestId('cleanup-fired')).toHaveText('yes');
  });

  test('schedule entry rejects non-finite time and connection stays healthy', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('trigger-invalid-schedule-time').click();
    await expect(page.getByTestId('schedule-guard-error')).toContainText('positive safe integer');
    // Sanity: the bad call did not corrupt the queue. A real schedule still fires.
    await page.getByTestId('schedule-cleanup-soon').click();
    await expect(page.getByTestId('cleanup-fired')).toHaveText('yes');
  });

  test('task-ctx sendToConnection: delivers to a live connection', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('connection-id')).not.toHaveText('');
    await page.getByTestId('schedule-send-to-self').click();
    await expect(page.getByTestId('send-to-conn-delivery')).toHaveText('from-task');

    await expect(page.getByTestId('send-to-conn-status')).toContainText('delivered:true');
  });

  test('task-ctx sendToConnection: stale id reports delivered:false', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('schedule-send-to-stale').click();
    await expect(page.getByTestId('send-to-conn-status')).toContainText(
      'id:stale-id-does-not-exist,delivered:false',
    );
    await expect(page.getByTestId('send-to-conn-delivery')).toHaveText('');
  });

  test('scheduled dead-letter: always-fail task lands in the DLQ', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('trigger-always-fail').click();
    // Poll the DLQ until a row shows up for the always-fail task.
    await expect(async () => {
      await page.getByTestId('query-dlq').click();
      await expect(page.getByTestId('dead-letter')).toContainText('always-fail-task');
    }).toPass({ timeout: 10_000 });
    // The stored error message must survive into the DLQ row.
    await expect(page.getByTestId('dead-letter')).toContainText('permanent failure');
  });

  test('scheduled empty backoff retry: fails once and goes to DLQ', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('trigger-empty-backoff').click();
    // With retry: [], task fires once, fails, goes to DLQ (no retries).
    await expect(async () => {
      await page.getByTestId('query-dlq').click();
      await expect(page.getByTestId('dead-letter')).toContainText('empty-backoff-task');
    }).toPass({ timeout: 10_000 });
  });

  test('scheduled task that throws a non-Error (BigInt) still lands in the DLQ', async ({
    page,
  }, testInfo) => {
    // The error serializer falls back to String(error) for non-serializable
    // thrown values, so the failed run can still be written to the dead letter queue.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('trigger-bigint-throw').click();
    await expect(async () => {
      await page.getByTestId('query-dlq').click();
      await expect(page.getByTestId('dead-letter')).toContainText('bigint-throw-task');
    }).toPass({ timeout: 10_000 });
  });

  test('scheduled task: ctx.broadcast sends to all connections', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    // Open two connections.
    await openPage(page, room, 'user1');
    const page2 = await page.context().newPage();
    await openPage(page2, room, 'user2');

    // Schedule task that broadcasts.
    await page.getByTestId('schedule-broadcast-task').click();
    // Both connections should receive the broadcast.
    await expect(page.getByTestId('broadcast-result')).toContainText('from-task');
    await expect(page2.getByTestId('broadcast-result')).toContainText('from-task');
    await page2.close();
  });

  test('scheduled task: ctx.sendTo tags targets specific connections', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await openPage(page, room, 'user1');
    const page2 = await page.context().newPage();
    await openPage(page2, room, 'user2');

    // Tag user2 as 'vip'.
    await page2.getByTestId('tag-vip').click();
    await page.getByTestId('schedule-send-to-tag').click();
    // Only user2 (vip) receives it.
    await expect(page2.getByTestId('send-to-tag-result')).toContainText('tagged-from-task');
    await expect(page.getByTestId('send-to-tag-result')).toHaveText('');
    await page2.close();
  });

  test('cancelScheduled on a never-registered task id throws and leaves the connection healthy', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('cancel-nonexistent-task').click();
    await expect(page.getByTestId('cancel-nonexistent-ok')).toHaveText('yes');
    // Positive signal: connection still healthy.
    await page.getByTestId('schedule-cleanup-soon').click();
    await expect(page.getByTestId('cleanup-fired')).toHaveText('yes');
  });

  test('ctx.schedule on an unregistered task id throws synchronously', async ({
    page,
  }, testInfo) => {
    // Unknown task IDs throw at schedule time so typos are reported immediately.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('schedule-unknown-task').click();
    await expect(page.getByTestId('schedule-unknown-task-result')).toContainText('rejected:');
    await expect(page.getByTestId('schedule-unknown-task-result')).toContainText(
      'is not registered',
    );
  });

  test('cancelScheduled on a recurring task stops further runs', async ({ page }, testInfo) => {
    const room = `sched-x-${testInfo.testId}`;
    await page.goto('/scheduled');
    await installRig(page);
    const a = await connect(page, { path: '/ws/scheduled', username: 'alice', room });

    await send(page, a, { event: 'start-heartbeat', payload: {} });
    // Recurring tick is every: 300ms; wait for at least two ticks.
    await expect(async () => {
      const ticks = (await frames(page, a)).filter((f) => f.event === 'heartbeat-tick');
      expect(ticks.length).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 10_000 });

    await send(page, a, { event: 'cancel-heartbeat', payload: {} });
    await waitForFrame(page, a, { match: (f) => f.event === 'cleanup-cancelled' });

    const countAtCancel = (await frames(page, a)).filter(
      (f) => f.event === 'heartbeat-tick',
    ).length;
    // Wait past several tick intervals (300ms each) to prove the cancel stuck.
    await page.waitForTimeout(1200);
    const countAfter = (await frames(page, a)).filter((f) => f.event === 'heartbeat-tick').length;
    expect(countAfter).toBe(countAtCancel);
  });

  test('a cancelled recurring task stays stopped after a restart until it is scheduled again', async ({
    page,
    request,
  }, testInfo) => {
    const room = `sched-x-${testInfo.testId}`;
    await page.goto('/scheduled');
    await installRig(page);
    const a = await connect(page, { path: '/ws/scheduled', username: 'alice', room });

    // The recurring task is seeded at boot; wait for it to tick.
    await expect(async () => {
      const ticks = (await frames(page, a)).filter((f) => f.event === 'heartbeat-tick');
      expect(ticks.length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 10_000 });

    await send(page, a, { event: 'cancel-heartbeat', payload: {} });
    await waitForFrame(page, a, { match: (f) => f.event === 'cleanup-cancelled' });

    const res = await request.get(`/ws/scheduled/restart?room=${room}`);
    expect(res.status()).toBe(204);

    // A fresh boot must not re-seed the cancelled task.
    const b = await connect(page, { path: '/ws/scheduled', username: 'bob', room });
    await page.waitForTimeout(1200);
    expect((await frames(page, b)).filter((f) => f.event === 'heartbeat-tick')).toHaveLength(0);

    // Scheduling it again restarts the recurring cycle, not just one run.
    await send(page, b, { event: 'start-heartbeat', payload: {} });
    await expect(async () => {
      const ticks = (await frames(page, b)).filter((f) => f.event === 'heartbeat-tick');
      expect(ticks.length).toBeGreaterThanOrEqual(3);
    }).toPass({ timeout: 10_000 });
  });

  test('scheduled queue survives a restart and the task still fires', async ({
    page,
    request,
  }, testInfo) => {
    const room = `sched-x-${testInfo.testId}`;
    await page.goto('/scheduled');
    await installRig(page);
    const a = await connect(page, { path: '/ws/scheduled', username: 'alice', room });

    // Schedule far enough out that the restart lands before it fires.
    await send(page, a, { event: 'schedule-cleanup', payload: { delayMs: 1500 } });

    // restart() aborts the DO: in-memory state and socket `a` are dropped,
    // but the durable scheduled queue + alarm survive in storage.
    const res = await request.get(`/ws/scheduled/restart?room=${room}`);
    expect(res.status()).toBe(204);

    // Re-connect a fresh socket to the same room; the DO re-initializes from
    // storage and the queued cleanup still runs. It writes a row when it runs,
    // so read that row: its broadcast can fire before this socket joins.
    const b = await connect(page, { path: '/ws/scheduled', username: 'bob', room });
    await expect(async () => {
      await send(page, b, { event: 'query-cleanup-history', payload: {} });
      const results = (await frames(page, b)).filter((f) => f.event === 'cleanup-history-result');
      expect(results.at(-1)?.payload.ranAt).toEqual(expect.any(Number));
    }).toPass({ timeout: 8000 });
  });

  test('socketless fixture stays alive while a scheduled task is pending', async ({
    page,
  }, testInfo) => {
    const room = `sched-idle-${testInfo.testId}`;
    await page.goto('/scheduled');
    await installRig(page);
    const a = await connect(page, { path: '/ws/scheduled', username: 'alice', room });

    await send(page, a, { event: 'schedule-cleanup', payload: { delayMs: 1500 } });
    await waitForFrame(page, a, { match: (f) => f.event === 'cleanup-scheduled' });
    await closeSocket(page, a);

    // The task is due 1500 ms after the close. Wait long enough that it has
    // clearly run before the reconnect, even on a slow machine.
    await page.waitForTimeout(3000);
    const reconnectStartedAt = Date.now();
    const b = await connect(page, { path: '/ws/scheduled', username: 'bob', room });
    await send(page, b, { event: 'query-cleanup-history', payload: {} });
    const result = await waitForFrame(page, b, {
      match: (f) => f.event === 'cleanup-history-result',
    });

    const ranAt = result.payload.ranAt;
    expect(typeof ranAt).toBe('number');
    expect(ranAt as number).toBeLessThan(reconnectStartedAt - 250);
  });
});
