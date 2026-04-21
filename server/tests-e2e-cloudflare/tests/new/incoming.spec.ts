import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('incoming', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/incoming?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('incoming handler runs when the matching event arrives', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });

  test('_replay against a handler without replay enabled is handled gracefully', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send _replay; server should drop it silently (not crash the connection).
    await page.getByTestId('send-replay').click();
    // Connection must stay alive and process subsequent frames normally.
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
    await expect(page.getByTestId('status')).toHaveText('connected');
  });
});
