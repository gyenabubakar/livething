import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's ack() against the real wskit `ack` handler.
// Adapter-oblivious — it talks to whatever server the run booted over the /ws
// proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/ack/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('ack (conformance)', () => {
  test('sendWithAck() resolves when the server __ack__s', async ({ page }, testInfo) => {
    await open(page, `ack-ok-${testInfo.testId}`);
    await page.getByTestId('send-ok').click();
    await expect(page.getByTestId('acked')).toHaveText('yes');
  });

  test('a throwing handler rejects sendWithAck with the server error code', async ({
    page,
  }, testInfo) => {
    await open(page, `ack-throw-${testInfo.testId}`);
    await page.getByTestId('send-throw').click();
    // The handler throw becomes a correlated __error__ (internal-error), so the
    // ack primitive rejects with it rather than waiting out the timeout.
    await expect(page.getByTestId('throw-error')).toHaveText('internal-error');
  });
});
