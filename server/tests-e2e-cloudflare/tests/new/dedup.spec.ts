import { expect, test } from '@playwright/test';

test.describe('dedup', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/dedup?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('outgoing messages have unique _messageId', async ({ page }) => {
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('1');
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('2');

    const ids = (await page.getByTestId('outgoing-ids').textContent()) ?? '';
    const idList = ids.split(',').filter(Boolean);
    expect(idList.length).toBeGreaterThanOrEqual(2);
    expect(new Set(idList).size).toBe(idList.length);
  });

  test('incoming frames with a repeated _messageId run the handler once', async ({ page }) => {
    await page.getByTestId('echo-dup-id').click();
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');

    // Same fixed id; dedup should drop this before the handler.
    await page.getByTestId('echo-dup-id').click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');
  });

  test('incoming frames without a _messageId are always dispatched', async ({ page }) => {
    await page.getByTestId('echo-no-id').click();
    await expect(page.getByTestId('count-no-id')).toHaveText('1');

    // No _messageId — at-least-once semantics, handler runs again.
    await page.getByTestId('echo-no-id').click();
    await expect(page.getByTestId('count-no-id')).toHaveText('2');
  });
});
