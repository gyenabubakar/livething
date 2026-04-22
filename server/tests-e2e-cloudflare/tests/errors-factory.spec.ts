import { expect, test } from '@playwright/test';

test.describe('errors-factory', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/errors-factory?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('throwing a registered error delivers it on the _error channel', async ({ page }) => {
    await page.getByTestId('trigger-not-found').click();
    await expect(page.getByTestId('error-result')).toContainText('not-found');
    await expect(page.getByTestId('error-result')).toContainText('test-123');
  });

  test('a second registered error factory works the same way', async ({ page }) => {
    await page.getByTestId('trigger-forbidden').click();
    await expect(page.getByTestId('error-result')).toContainText('forbidden');
    await expect(page.getByTestId('error-result')).toContainText('Access denied');
  });
});
