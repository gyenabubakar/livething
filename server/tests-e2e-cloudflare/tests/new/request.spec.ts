import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('request', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/request?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('top-level request: ctx.respond sends a reply tied to the request id', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('get-time').click();
    await expect(page.getByTestId('last-response')).toContainText('fixed-now-string');
  });

  test('namespace-scoped request returns a response inside the namespace', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('get-ns-info').click();
    await expect(page.getByTestId('last-response')).toContainText('"namespace":"ns"');
  });

  test('channel-scoped request returns the matched channel name', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('get-ch-info').click();
    await expect(page.getByTestId('last-response')).toContainText('"channel":"room"');
  });
});
