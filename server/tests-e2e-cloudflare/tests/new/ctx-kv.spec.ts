import { expect, test } from '@playwright/test';

test.describe('ctx-kv', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-kv?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('set then get returns the stored value', async ({ page }) => {
    await page.getByTestId('set-basic').click();
    await expect(page.getByTestId('value-basic')).toHaveText('hello');
    await page.getByTestId('get-basic').click();
    await expect(page.getByTestId('value-basic')).toHaveText('hello');
  });

  test('delete removes a stored value (subsequent get returns null)', async ({ page }) => {
    await page.getByTestId('set-gone').click();
    await expect(page.getByTestId('value-gone')).toHaveText('here');

    await page.getByTestId('delete-gone').click();
    await expect(page.getByTestId('value-gone')).toHaveText('null');

    await page.getByTestId('get-gone').click();
    await expect(page.getByTestId('value-gone')).toHaveText('null');
  });

  test('set with ttl expires within the window (get returns null after ttl)', async ({ page }) => {
    await page.getByTestId('set-ttl').click();
    await expect(page.getByTestId('value-ttl')).toHaveText('ephemeral');

    // Handler set ttlMs: 300. Wait safely past it, then get.
    await page.waitForTimeout(900);
    await page.getByTestId('get-ttl').click();
    await expect(page.getByTestId('value-ttl')).not.toHaveText('ephemeral');
  });
});
