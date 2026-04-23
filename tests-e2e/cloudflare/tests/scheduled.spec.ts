import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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

  test('cancelScheduled with no matching task id succeeds silently', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('cancel-nothing').click();
    await expect(page.getByTestId('cancel-nothing-ok')).toHaveText('yes');
    // Positive signal: connection still healthy, future tasks still work.
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

  test('cancelScheduled on never-registered task id succeeds silently', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('cancel-nonexistent-task').click();
    await expect(page.getByTestId('cancel-nonexistent-ok')).toHaveText('yes');
    // Positive signal: connection still healthy.
    await page.getByTestId('schedule-cleanup-soon').click();
    await expect(page.getByTestId('cleanup-fired')).toHaveText('yes');
  });
});
