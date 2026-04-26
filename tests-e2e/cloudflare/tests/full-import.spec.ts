import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('full-import', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/full-import?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
  }

  test('greeting from onConnect arrives (lifecycle is wired through @wskit/server/full)', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await expect(page.getByTestId('greetings')).toContainText('welcome testuser');
  });

  test('incoming + outgoing + ack all reachable from one full import', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-hi').click();
    await expect(page.getByTestId('greetings')).toContainText('hi alice');
    await expect(page.getByTestId('ack-ids')).toHaveText('ack-1');
  });

  test('request-response handler is reachable from full import', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-ping').click();
    await expect(page.getByTestId('pong')).toContainText('"ts":42');
    await expect(page.getByTestId('pong')).toContainText('"serverTs":1');
  });
});
