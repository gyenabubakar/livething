import { expect, test } from '@playwright/test';

test.describe('protocol pings', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/protocol-pings?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('raw text ping returns raw text pong', async ({ page }) => {
    await page.getByTestId('raw-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText('pong');
  });

  test('JSON {event:ping} returns JSON {event:pong}', async ({ page }) => {
    await page.getByTestId('json-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText(/"event":"pong"/);
  });
});
