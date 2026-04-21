import { expect, test } from '@playwright/test';

test.describe('ctx-tags', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-tags?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('tag and untag self', async ({ page }) => {
    await page.getByTestId('tag-vip').click();
    await expect(page.getByTestId('tags')).toContainText('vip');

    await page.getByTestId('untag-vip').click();
    await expect(page.getByTestId('tags')).not.toContainText('vip');
  });

  test('ctx.getConnections returns a count for the current DO', async ({ page }) => {
    await page.getByTestId('conn-info').click();
    await expect(page.getByTestId('conn-count')).toHaveText(/[1-9]\d*/);
  });

  test('ctx.getConnectionsByTag returns self', async ({ page }) => {
    // onUpgrade tags this connection with its username; so the username tag
    // should match exactly this one connection.
    await page.getByTestId('get-by-username').click();
    await expect(page.getByTestId('by-tag')).toHaveText(/testuser:[1-9]\d*/);
  });
});
