import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: a query param built by an async URL function reaches the server on connect.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/async-url/index.html?room=${room}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('async-url (conformance)', () => {
  test('the async URL function username reaches the server upgrade and comes back via who-am-i', async ({
    page,
  }, testInfo) => {
    await open(page, `async-url-${testInfo.testId}`);
    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('username')).toHaveText('q-user');
  });
});
