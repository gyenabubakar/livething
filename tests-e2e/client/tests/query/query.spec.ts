import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: query() params reach the server on connect.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/query/index.html?room=${room}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('query (conformance)', () => {
  test('query() username reaches the server upgrade and comes back via who-am-i', async ({
    page,
  }, testInfo) => {
    await open(page, `query-${testInfo.testId}`);
    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('username')).toHaveText('q-user');
  });
});
