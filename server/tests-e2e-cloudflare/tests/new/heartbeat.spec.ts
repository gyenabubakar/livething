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
});
