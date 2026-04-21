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

    // Positive signal: follow the throw with a second successful send. Once
    // its ack arrives, the throw-me frame has fully been processed — if its
    // ack were going to come, it would be in the list by now.
    await page.getByTestId('send-ok-2').click();
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok-2');
    await expect(page.getByTestId('ack-ids')).not.toContainText('ack-throw');
  });
});
