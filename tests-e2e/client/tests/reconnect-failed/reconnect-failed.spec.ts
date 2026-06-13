import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: reconnection gives up after maxAttempts and reports it.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/reconnect-failed/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
}

test.describe('reconnect-failed (conformance)', () => {
  test('onReconnectFailed fires after the attempt budget is spent', async ({ page }, testInfo) => {
    await open(page, `reconnect-failed-${testInfo.testId}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('reconnect-failed')).toHaveText('yes');
    await expect(page.getByTestId('status')).toHaveText('closed');
  });
});
