import { expect, test } from '@playwright/test';

test.describe('ctx-meta', () => {
  test('ctx.meta (set by onUpgrade) is readable in an incoming handler', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-meta?room=${room}`);
    await page.getByTestId('username').fill('meta-alice');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('echoed-username')).toHaveText('meta-alice');
  });
});
