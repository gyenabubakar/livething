import { expect, test } from '@playwright/test';

test.describe('heartbeat', () => {
  test('idle connection is closed with CloseCodes.IDLE (4004) after timeout', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/heartbeat?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Stay silent. Handler has heartbeat({ timeout: 1_000 }); wait > timeout.
    await expect(page.getByTestId('status')).toHaveText('disconnected', { timeout: 10_000 });
    await expect(page.getByTestId('close-code')).toHaveText('4004');
  });

  test('activity resets the idle timer, keeping connection alive', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/heartbeat?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Handler timeout is 1_000 ms. Send a message at 300 ms, then wait another 300 ms.
    // If activity resets timer, total silence is never 1_000 ms, so connection stays.
    // Using 300 ms (30 % of timeout) gives a 2× load buffer before timing out.
    await page.waitForTimeout(300);
    await page.getByTestId('send-echo').click();
    await page.waitForTimeout(300);

    // Should still be connected (total silence never reached 1_000 ms).
    await expect(page.getByTestId('status')).toHaveText('connected');
  });
});
