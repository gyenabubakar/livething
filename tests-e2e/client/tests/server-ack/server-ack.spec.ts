import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's ack() auto-confirms a server-initiated
// sendWithAck against the real `server-ack` handler. The drop/timeout path is
// raw-only — the real client always auto-confirms, so there is no typed way to
// withhold the receipt. Adapter-oblivious — it talks to whatever server the run
// booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/server-ack/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('server-ack (conformance)', () => {
  test('ctx.connection(ref).sendWithAck resolves when the client auto-confirms', async ({
    page,
  }, testInfo) => {
    await open(page, `sack-conn-${testInfo.testId}`);
    await page.getByTestId('trigger').click();

    await expect(page.getByTestId('acked-theme')).toHaveText('dark');
    await expect(page.getByTestId('outcome')).toHaveText('true');
  });

  test('ctx.sendWithAck resolves when the client auto-confirms', async ({ page }, testInfo) => {
    await open(page, `sack-self-${testInfo.testId}`);
    await page.getByTestId('trigger-self').click();

    await expect(page.getByTestId('acked-theme')).toHaveText('dark');
    await expect(page.getByTestId('outcome')).toHaveText('true');
  });
});
