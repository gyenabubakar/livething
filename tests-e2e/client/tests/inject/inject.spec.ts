import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client/testing inject helpers dispatch through the local
// pipeline to on() handlers with no server connection.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/inject/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
}

test.describe('inject (conformance)', () => {
  test('inject() dispatches a top-level event to its handler (no connection)', async ({
    page,
  }, testInfo) => {
    await open(page, `inject-top-${testInfo.testId}`);
    await page.getByTestId('inject-top').click();
    await expect(page.getByTestId('top-result')).toHaveText('injected');
  });

  test('injectChannel() routes to the channel handler', async ({ page }, testInfo) => {
    await open(page, `inject-chan-${testInfo.testId}`);
    await page.getByTestId('inject-channel').click();
    await expect(page.getByTestId('channel-result')).toHaveText('sys:hi');
  });

  test('injectNamespace() routes to the namespace handler', async ({ page }, testInfo) => {
    await open(page, `inject-ns-${testInfo.testId}`);
    await page.getByTestId('inject-namespace').click();
    await expect(page.getByTestId('namespace-result')).toHaveText('v1-pong');
  });
});
