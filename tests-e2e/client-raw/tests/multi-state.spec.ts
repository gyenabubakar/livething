import { expect, test } from '@playwright/test';

test.describe('multi-state', () => {
  test('add-five-tags handler completes and returns one ack', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/multi-state?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('add-batch').click();
    await expect(page.getByTestId('batch-acks')).toHaveText('1');
  });

  test('add then remove batches both ack', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/multi-state?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('add-batch').click();
    await expect(page.getByTestId('batch-acks')).toHaveText('1');

    await page.getByTestId('remove-batch').click();
    await expect(page.getByTestId('batch-acks')).toHaveText('2');
  });
});
