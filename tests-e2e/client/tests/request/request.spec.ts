import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's request() against the real wskit `request`
// handler. Adapter-oblivious — it talks to whatever server the run booted over
// the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/request/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('request (conformance)', () => {
  test('request() resolves with the typed response', async ({ page }, testInfo) => {
    await open(page, `req-time-${testInfo.testId}`);
    await page.getByTestId('get-time').click();
    await expect(page.getByTestId('time')).toHaveText('fixed-now-string');
  });

  test('a handler that never responds rejects with request-no-response', async ({
    page,
  }, testInfo) => {
    await open(page, `req-noresp-${testInfo.testId}`);
    await page.getByTestId('no-response').click();
    await expect(page.getByTestId('no-response-error')).toHaveText('request-no-response');
  });

  test('channel-scoped request resolves after subscribe', async ({ page }, testInfo) => {
    await open(page, `req-ch-${testInfo.testId}`);
    await page.getByTestId('sub-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('ch-info').click();
    await expect(page.getByTestId('ch-result')).toHaveText('room');
  });
});
