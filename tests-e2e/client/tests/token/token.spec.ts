import { expect, test } from '@playwright/test';

// Conformance: the `token` option reaches the server's authenticate as `Authorization`,
// and the browser accepts the server's subprotocol answer.
test.describe('token (conformance)', () => {
  test('the token reaches authenticate and comes back via who-am-i', async ({ page }, testInfo) => {
    await page.goto(`/tests/token/index.html?room=token-${testInfo.testId}`);
    await expect(page.getByTestId('app-ready')).toHaveText('yes');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('open');

    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('username')).toHaveText('token-user');
    await expect(page.getByTestId('protocol')).toHaveText('null');
  });
});
