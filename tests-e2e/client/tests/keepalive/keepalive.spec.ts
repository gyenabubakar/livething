import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's keepalive() + quality() against the real wskit
// `keepalive` handler. Adapter-oblivious — it talks to whatever server the run
// booted over the /ws proxy. The handler pings every 1s and closes after 2s of
// silence.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/keepalive/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('keepalive (conformance)', () => {
  test('keepalive measures latency and reports a healthy quality tier', async ({
    page,
  }, testInfo) => {
    await open(page, `ka-quality-${testInfo.testId}`);

    await expect(page.getByTestId('quality-changed')).toHaveText('yes', { timeout: 5_000 });
    await expect(page.getByTestId('latency')).toHaveText(/^\d+(\.\d+)?$/, { timeout: 5_000 });
    await expect(page.getByTestId('quality')).toHaveText(/^(excellent|good|degraded)$/, {
      timeout: 5_000,
    });
  });

  test('the client stays open past the server idle window', async ({ page }, testInfo) => {
    await open(page, `ka-liveness-${testInfo.testId}`);

    // Idle window is 2s. Wait well past it without sending a single app message;
    // the auto-pong and client pings keep the connection alive.
    await page.waitForTimeout(5_000);
    await expect(page.getByTestId('status')).toHaveText('open');
  });
});
