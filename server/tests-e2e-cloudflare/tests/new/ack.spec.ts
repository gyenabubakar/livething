import { expect, test } from '@playwright/test';

test.describe('ack', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ack?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('handler that completes successfully emits _ack with the caller-provided _ackId', async ({
    page,
  }) => {
    await page.getByTestId('send-ok').click();
    await expect(page.getByTestId('reply')).toHaveText('yes');
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok');
  });

  test('ack is not emitted when handler throws', async ({ page }) => {
    // Baseline ack proves the wire is healthy.
    await page.getByTestId('send-ok').click();
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok');

    // Throwing handler never calls ctx.ack(); no _ack frame should arrive.
    await page.getByTestId('send-throw').click();

    // Healthy acks are sub-500ms (proven by baseline). 1s is a generous margin.
    await page.waitForTimeout(1_000);
    await expect(page.getByTestId('ack-ids')).not.toContainText('ack-throw');
  });
});
