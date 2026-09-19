import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @livething/client's close-code-aware reconnection against the real
// LiveThing `errors-control-flow` server definition. Adapter-oblivious — it talks to whatever
// server the run booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/errors-control-flow/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('errors-control-flow (conformance)', () => {
  test('a non-retryable close code settles the socket to closed, not reconnecting', async ({
    page,
  }, testInfo) => {
    await open(page, `ecf-nonretry-${testInfo.testId}`);
    await page.getByTestId('force-disconnect').click();
    await expect(page.getByTestId('status')).toHaveText('closed');
  });

  test('onClose reports the server close code and reason', async ({ page }, testInfo) => {
    await open(page, `ecf-onclose-${testInfo.testId}`);
    await page.getByTestId('force-disconnect').click();
    await expect(page.getByTestId('close-code')).toHaveText('4009');
    await expect(page.getByTestId('close-reason')).toHaveText('force disconnect');
  });
});
