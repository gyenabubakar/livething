import { expect, test } from '@playwright/test';

// Phase 4: server→client two-way ack, exercised over the real wire. The page
// connects raw; the server sends an event with `sendWithAck`, and the page
// either echoes the __ack__ receipt (what the real client does automatically)
// or drops it — so a real receipt round-trip and a timeout are both observable
// end to end.
test.describe('server→client ack', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/server-ack?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('round-trip: the client confirms and the server promise resolves', async ({ page }) => {
    await page.getByTestId('ack-confirm').click();
    await page.getByTestId('trigger').click();

    // The server pushed the acked event...
    await expect(page.getByTestId('acked-theme')).toHaveText('dark');
    // ...and its sendWithAck promise resolved on the client's receipt.
    await expect(page.getByTestId('outcome')).toHaveText('true');
  });

  test('no receipt before the timeout rejects with timeout', async ({ page }) => {
    await page.getByTestId('ack-drop').click();
    await page.getByTestId('trigger-timeout').click();

    await expect(page.getByTestId('acked-theme')).toHaveText('dark');
    await expect(page.getByTestId('error-outcome')).toHaveText('timeout');
  });
});
