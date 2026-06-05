import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: connect() accepts a URL function, re-invoked on each reconnect.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/dynamic-url/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('dynamic-url (conformance)', () => {
  test('the URL function runs once on connect', async ({ page }, testInfo) => {
    await open(page, `dyn-url-once-${testInfo.testId}`);
    await expect(page.getByTestId('url-count')).toHaveText('1');
    await expect(page.getByTestId('hook-order')).toHaveText('open');
  });

  test('the URL function runs again on reconnect, and onOpen precedes onReconnect', async ({
    page,
  }, testInfo) => {
    await open(page, `dyn-url-reconnect-${testInfo.testId}`);
    await page.getByTestId('drop').click();
    // Server-initiated retryable close → reconnection reopens via the function.
    await expect(page.getByTestId('status')).toHaveText('open');
    await expect(page.getByTestId('url-count')).toHaveText('2');
    await expect(page.getByTestId('hook-order')).toHaveText('open,open,reconnect');
  });
});
