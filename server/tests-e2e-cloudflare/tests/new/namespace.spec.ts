import { expect, test } from '@playwright/test';

test.describe('namespace', () => {
  test('events sent inside a namespace reach the same connection via ctx.namespace.send', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/namespace?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('send-ns').click();
    await expect(page.getByTestId('ns-message')).toHaveText('hello ns');
  });
});
